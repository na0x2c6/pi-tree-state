import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Workspace } from "../src/workspace.ts";

let base: string;
let store: string;
let parent: string;
let nested: string;
let elsewhere: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const write = (dir: string, name: string, text: string) => writeFileSync(join(dir, name), text);

function createRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  write(dir, "file.txt", "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "workspace-test-"));
  store = join(base, "store");
  parent = join(base, "parent");
  nested = join(parent, "nested");
  elsewhere = join(base, "elsewhere");
  createRepo(parent);
  createRepo(nested);
  createRepo(elsewhere);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const open = (cwd = parent, session = "s1", ancestors: string[] = []) => Workspace.open(cwd, store, session, ancestors);
const reflog = (dir: string, session = "s1") => git(dir, "reflog", "show", `refs/pi/sessions/${session}`, "--format=%gs");

describe("track", () => {
  it("records a repository before the tool changes it", async () => {
    const workspace = await open();
    await workspace.track(join(elsewhere, "file.txt"));
    write(elsewhere, "file.txt", "changed\n");
    await workspace.snapshot(["e1"]);

    assert.deepEqual(reflog(elsewhere).split("\n"), ["entry=e1", "entry=root"]);
    const [planned] = await workspace.plan([]);
    assert.equal(git(elsewhere, "show", `${planned.commit}:file.txt`), "base");
  });

  it("finds the repository of a file that does not exist yet", async () => {
    const workspace = await open();
    await workspace.track(join(elsewhere, "new/deep/file.txt"));
    assert.ok(workspace.roots.includes(elsewhere));
  });

  it("takes a repository that .gitignore hides from the parent", async () => {
    write(parent, ".gitignore", "nested/\n");
    const workspace = await open();
    await workspace.track(join(nested, "file.txt"));
    assert.ok(workspace.roots.includes(nested));
  });

  it("ignores a file outside any repository", async () => {
    mkdirSync(join(base, "plain"));
    const workspace = await open();
    await workspace.track(join(base, "plain/file.txt"));
    assert.deepEqual(workspace.roots.sort(), [parent]);
  });

  it("records one baseline when parallel calls reach the same repository", async () => {
    const workspace = await open();
    await Promise.all([workspace.track(join(elsewhere, "a")), workspace.track(join(elsewhere, "b"))]);
    assert.equal(reflog(elsewhere), "entry=root");
  });

  it("works from a directory that is no repository", async () => {
    mkdirSync(join(base, "plain"));
    const workspace = await open(join(base, "plain"));
    assert.deepEqual(workspace.roots, []);
    await workspace.track(join(elsewhere, "file.txt"));
    assert.deepEqual(workspace.roots, [elsewhere]);
  });
});

describe("snapshot", () => {
  it("finds a nested repository by itself, for what bash changes there", async () => {
    const workspace = await open();
    await workspace.snapshot(["e1"]);
    assert.ok(workspace.roots.includes(nested));
    write(nested, "file.txt", "by bash\n");
    await workspace.snapshot(["e1", "e2"]);
    assert.deepEqual(reflog(nested).split("\n"), ["entry=e2", "entry=root"]);
  });

  it("names the same entry in every repository a turn changed", async () => {
    const workspace = await open();
    await workspace.snapshot(["e0"]);
    await workspace.track(join(elsewhere, "file.txt"));
    write(parent, "file.txt", "parent\n");
    write(nested, "file.txt", "nested\n");
    write(elsewhere, "file.txt", "elsewhere\n");
    await workspace.snapshot(["e0", "e1"]);
    for (const dir of [parent, nested, elsewhere]) assert.match(reflog(dir), /entry=e1/);
  });

  it("records only the repositories that changed", async () => {
    const workspace = await open();
    await workspace.snapshot(["e1"]);
    write(parent, "file.txt", "parent\n");
    await workspace.snapshot(["e1", "e2"]);
    assert.doesNotMatch(reflog(nested), /entry=e2/);
    assert.match(reflog(parent), /entry=e2/);
  });

  it("survives a repository that was removed", async () => {
    const workspace = await open();
    await workspace.track(join(elsewhere, "file.txt"));
    rmSync(elsewhere, { recursive: true });
    await workspace.snapshot(["e1"]);
    assert.match(reflog(parent), /entry=e1/);
  });
});

describe("plan and restore", () => {
  async function twoStates() {
    const workspace = await open();
    await workspace.snapshot(["e0"]);
    await workspace.track(join(elsewhere, "file.txt"));
    write(parent, "file.txt", "one\n");
    write(nested, "file.txt", "one\n");
    write(elsewhere, "file.txt", "one\n");
    await workspace.snapshot(["e0", "e1"]);
    write(parent, "file.txt", "two\n");
    write(nested, "file.txt", "two\n");
    write(nested, "added.txt", "two\n");
    write(elsewhere, "file.txt", "two\n");
    await workspace.snapshot(["e0", "e1", "e2"]);
    return workspace;
  }

  it("brings every repository of a point back together", async () => {
    const workspace = await twoStates();
    const planned = await workspace.plan(["e0", "e1"]);
    assert.equal(planned.length, 3);
    assert.deepEqual(await workspace.restore(planned, "worktree"), []);
    for (const dir of [parent, nested, elsewhere]) assert.equal(read(dir, "file.txt"), "one\n");
    assert.equal(existsSync(join(nested, "added.txt")), false);
  });

  it("plans only what differs", async () => {
    const workspace = await twoStates();
    await workspace.restore(await workspace.plan(["e0", "e1"]), "worktree");
    write(parent, "file.txt", "two\n");
    const planned = await workspace.plan(["e0", "e1"]);
    assert.deepEqual(planned.map(({ repo }) => repo.root), [parent]);
  });

  it("takes a repository back to its baseline for a point before it was touched", async () => {
    const workspace = await open();
    await workspace.snapshot(["e1"]);
    await workspace.track(join(elsewhere, "file.txt"));
    write(elsewhere, "file.txt", "later\n");
    await workspace.snapshot(["e1", "e2"]);

    await workspace.restore(await workspace.plan(["e1"]), "worktree");
    assert.equal(read(elsewhere, "file.txt"), "base\n");
  });

  it("restores the others when one fails, and reports it", async () => {
    const workspace = await twoStates();
    const planned = await workspace.plan(["e0", "e1"]);
    const broken = planned.find(({ repo }) => repo.root === nested)!;
    broken.commit = "0000000000000000000000000000000000000001";
    const failed = await workspace.restore(planned, "worktree");
    assert.equal(failed.length, 1);
    assert.match(failed[0], /nested/);
    assert.equal(read(parent, "file.txt"), "one\n");
    assert.equal(read(elsewhere, "file.txt"), "one\n");
  });

  it("undo covers every repository of the last restore, across a restart", async () => {
    const workspace = await twoStates();
    await workspace.restore(await workspace.plan(["e0", "e1"]), "worktree+index");

    const restarted = await open();
    assert.equal(await restarted.undo(), true);
    for (const dir of [parent, nested, elsewhere]) assert.equal(read(dir, "file.txt"), "two\n");
    assert.equal(read(nested, "added.txt"), "two\n");
  });

  it("has nothing to undo before a restore", async () => {
    const workspace = await open();
    assert.equal(await workspace.undo(), false);
  });
});

describe("open", () => {
  it("knows the repositories of the session after a restart", async () => {
    const workspace = await open();
    await workspace.track(join(elsewhere, "file.txt"));
    assert.ok((await open()).roots.includes(elsewhere));
  });

  it("knows the repositories of the session a fork came from", async () => {
    const workspace = await open(parent, "parent-session");
    await workspace.track(join(elsewhere, "file.txt"));
    const fork = await open(parent, "fork", ["parent-session"]);
    assert.ok(fork.roots.includes(elsewhere));
  });

  it("skips a repository that is gone", async () => {
    const workspace = await open();
    await workspace.track(join(elsewhere, "file.txt"));
    rmSync(elsewhere, { recursive: true });
    assert.deepEqual((await open()).roots, [parent]);
  });
});
