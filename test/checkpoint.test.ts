import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Checkpoints } from "../src/checkpoint.ts";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trimEnd();
const write = (name: string, text: string) => writeFileSync(join(repo, name), text);
const read = (name: string) => readFileSync(join(repo, name), "utf8");
const status = () => git("status", "--short", "--untracked-files=all");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  write("tracked.txt", "base\n");
  write(".gitignore", "ignored.log\n");
  git("add", ".");
  git("commit", "-qm", "base");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

async function open(session = "s1", ancestors: string[] = []) {
  const checkpoints = await Checkpoints.open(repo, session, ancestors);
  assert.ok(checkpoints);
  return checkpoints;
}

describe("snapshot", () => {
  it("keeps staged, unstaged and untracked changes apart", async () => {
    const checkpoints = await open();
    write("tracked.txt", "base\nstaged\n");
    git("add", "tracked.txt");
    write("tracked.txt", "base\nstaged\nunstaged\n");
    write("new.txt", "untracked\n");

    const commit = await checkpoints.snapshot(["e1"]);
    assert.ok(commit);
    assert.equal(git("show", `${commit}^2:tracked.txt`), "base\nstaged");
    assert.equal(git("show", `${commit}:tracked.txt`), "base\nstaged\nunstaged");
    assert.equal(git("show", `${commit}^3:new.txt`), "untracked");
  });

  it("leaves the index, the worktree and the stash list alone", async () => {
    const checkpoints = await open();
    write("tracked.txt", "changed\n");
    write("new.txt", "untracked\n");
    const before = status();
    await checkpoints.snapshot(["e1"]);
    assert.equal(status(), before);
    assert.equal(git("stash", "list"), "");
  });

  it("works on a clean tree, where git stash create prints nothing", async () => {
    const checkpoints = await open();
    const commit = await checkpoints.snapshot(["e1"]);
    assert.ok(commit);
    assert.equal(git("rev-parse", `${commit}^{tree}`), git("rev-parse", "HEAD^{tree}"));
    assert.equal(git("rev-parse", `${commit}^2^{tree}`), git("rev-parse", "HEAD^{tree}"));
  });

  it("works when only the stat data of a file changed", async () => {
    const checkpoints = await open();
    utimesSync(join(repo, "tracked.txt"), new Date(0), new Date(0));
    assert.ok(await checkpoints.snapshot(["e1"]));
  });

  it("can be applied by hand with git stash apply --index", async () => {
    const checkpoints = await open();
    write("tracked.txt", "base\nstaged\n");
    git("add", "tracked.txt");
    write("tracked.txt", "base\nstaged\nunstaged\n");
    write("new.txt", "untracked\n");
    const commit = await checkpoints.snapshot(["e1"]);
    const before = status();

    git("reset", "-q", "--hard");
    rmSync(join(repo, "new.txt"));
    git("stash", "apply", "-q", "--index", commit!);
    assert.equal(status(), before);
  });

  it("skips ignored files", async () => {
    const checkpoints = await open();
    write("ignored.log", "noise\n");
    write("new.txt", "untracked\n");
    const commit = await checkpoints.snapshot(["e1"]);
    assert.equal(git("ls-tree", "--name-only", `${commit}^3`), "new.txt");
  });

  it("records nothing when the path already leads to the same code", async () => {
    const checkpoints = await open();
    const first = await checkpoints.snapshot(["e1"]);
    const second = await checkpoints.snapshot(["e1", "e2"]);
    assert.equal(second, first);
    assert.equal(git("reflog", "show", "refs/pi/sessions/s1", "--format=%gs"), "entry=e1");
  });

  it("logs the same code on two branches in the same second", async () => {
    const checkpoints = await open();
    await checkpoints.snapshot(["a"]);
    write("tracked.txt", "x\n");
    await checkpoints.snapshot(["a", "b"]);
    await checkpoints.snapshot(["a", "c"]);
    const restarted = await open();
    assert.equal(git("show", `${restarted.find(["a", "c"])}:tracked.txt`), "x");
  });

  it("records a state that differs from where the path leads, however late", async () => {
    const checkpoints = await open();
    await checkpoints.snapshot(["a"]);
    write("tracked.txt", "on branch b\n");
    await checkpoints.snapshot(["a", "b"]);
    // Back on a with the code of b kept.
    const c = await checkpoints.snapshot(["a", "c"]);
    assert.notEqual(c, checkpoints.find(["a"]));
    assert.equal(checkpoints.find(["a", "c"]), c);
    assert.equal(git("show", `${c}:tracked.txt`), "on branch b");
  });

  it("gives up on an unmerged index instead of failing", async () => {
    git("checkout", "-q", "-b", "other");
    write("tracked.txt", "other\n");
    git("commit", "-qam", "other");
    git("checkout", "-q", "main");
    write("tracked.txt", "main\n");
    git("commit", "-qam", "main");
    assert.throws(() => git("merge", "other"));
    const checkpoints = await open();
    assert.equal(await checkpoints.snapshot(["e1"]), undefined);
  });

  it("gives up before the first commit", async () => {
    rmSync(join(repo, ".git"), { recursive: true });
    git("init", "-q");
    const checkpoints = await open();
    assert.equal(await checkpoints.snapshot(["e1"]), undefined);
  });
});

describe("find", () => {
  it("takes the newest snapshot on the path", async () => {
    const checkpoints = await open();
    const a = await checkpoints.snapshot(["a"]);
    write("tracked.txt", "b\n");
    const b = await checkpoints.snapshot(["a", "b"]);
    assert.equal(checkpoints.find(["a", "b", "later"]), b);
    assert.equal(checkpoints.find(["a"]), a);
    assert.equal(checkpoints.find(["a", "other-branch"]), a);
  });

  it("survives a restart through the reflog", async () => {
    const first = await open();
    const a = await first.snapshot(["a"]);
    const second = await open();
    assert.equal(second.find(["a"]), a);
  });

  it("reaches the snapshots of the session a fork came from", async () => {
    const parent = await open("parent");
    const a = await parent.snapshot(["a"]);
    const fork = await open("fork", ["parent"]);
    assert.equal(fork.find(["a"]), a);
  });

  it("covers a session started in a clean tree through its root", async () => {
    const checkpoints = await open();
    const root = await checkpoints.snapshot([]);
    assert.equal(checkpoints.find(["unknown"]), root);
  });
});

describe("restore", () => {
  async function dirtySnapshot(checkpoints: Checkpoints) {
    write("tracked.txt", "base\nstaged\n");
    git("add", "tracked.txt");
    write("tracked.txt", "base\nstaged\nunstaged\n");
    write("kept-new.txt", "untracked\n");
    return (await checkpoints.snapshot(["e1"]))!;
  }

  function wander() {
    write("tracked.txt", "later\n");
    git("add", "tracked.txt");
    write("tracked.txt", "later, unstaged\n");
    rmSync(join(repo, "kept-new.txt"));
    write("added-later.txt", "later\n");
    mkdirSync(join(repo, "dir"));
    write("dir/nested.txt", "later\n");
  }

  it("worktree+index brings back both areas exactly", async () => {
    const checkpoints = await open();
    const commit = await dirtySnapshot(checkpoints);
    const before = status();
    wander();

    await checkpoints.restore(commit, "worktree+index", "1");
    assert.equal(status(), before);
    assert.equal(read("tracked.txt"), "base\nstaged\nunstaged\n");
    assert.equal(git("show", ":tracked.txt"), "base\nstaged");
    assert.equal(read("kept-new.txt"), "untracked\n");
    assert.equal(existsSync(join(repo, "added-later.txt")), false);
    assert.equal(existsSync(join(repo, "dir")), false);
  });

  it("worktree leaves the index as it is", async () => {
    const checkpoints = await open();
    const commit = await dirtySnapshot(checkpoints);
    wander();
    const staged = git("show", ":tracked.txt");

    await checkpoints.restore(commit, "worktree", "1");
    assert.equal(read("tracked.txt"), "base\nstaged\nunstaged\n");
    assert.equal(git("show", ":tracked.txt"), staged);
    assert.equal(read("kept-new.txt"), "untracked\n");
    assert.equal(existsSync(join(repo, "added-later.txt")), false);
  });

  it("does not touch ignored files or HEAD", async () => {
    const checkpoints = await open();
    const commit = await dirtySnapshot(checkpoints);
    write("ignored.log", "noise\n");
    write("tracked.txt", "committed later\n");
    git("add", "tracked.txt");
    git("commit", "-qm", "later");
    const head = git("rev-parse", "HEAD");

    await checkpoints.restore(commit, "worktree+index", "1");
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(read("ignored.log"), "noise\n");
    assert.equal(read("tracked.txt"), "base\nstaged\nunstaged\n");
  });

  it("replaces a directory with a file of the same name", async () => {
    const checkpoints = await open();
    write("thing", "file\n");
    const commit = (await checkpoints.snapshot(["e1"]))!;
    rmSync(join(repo, "thing"));
    mkdirSync(join(repo, "thing"));
    write("thing/inner.txt", "dir\n");

    await checkpoints.restore(commit, "worktree", "1");
    assert.equal(read("thing"), "file\n");
  });

  it("undo returns to the code before the restore, across a restart", async () => {
    const checkpoints = await open();
    const commit = await dirtySnapshot(checkpoints);
    wander();
    const before = status();
    await checkpoints.restore(commit, "worktree+index", "1");

    const restarted = await open();
    assert.equal(restarted.undoOperation, "1");
    await restarted.undo("2");
    assert.equal(status(), before);
    assert.equal(read("added-later.txt"), "later\n");
  });

  it("logs an undo point that is the same code as the last snapshot", async () => {
    const checkpoints = await open();
    const first = (await checkpoints.snapshot(["e1"]))!;
    write("tracked.txt", "two\n");
    await checkpoints.snapshot(["e1", "e2"]);
    await checkpoints.restore(first, "worktree", "1");
    assert.equal((await open()).undoOperation, "1");
  });

  it("tells whether a restore would change anything", async () => {
    const checkpoints = await open();
    const commit = (await checkpoints.snapshot(["e1"]))!;
    assert.equal(await checkpoints.differs(commit), false);
    write("new.txt", "x\n");
    assert.equal(await checkpoints.differs(commit), true);
    rmSync(join(repo, "new.txt"));
    write("tracked.txt", "x\n");
    git("add", "tracked.txt");
    git("checkout", "HEAD", "--", "tracked.txt");
    assert.equal(await checkpoints.differs(commit), false);
  });
});

describe("nested", () => {
  it("lists repositories inside this one and submodules, not plain directories", async () => {
    mkdirSync(join(repo, "plain"));
    write("plain/file.txt", "x\n");
    mkdirSync(join(repo, "inner"));
    execFileSync("git", ["init", "-q"], { cwd: join(repo, "inner") });
    const inner = join(repo, "inner");
    writeFileSync(join(inner, "f"), "x\n");
    execFileSync("git", ["add", "."], { cwd: inner });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], { cwd: inner });
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub");

    const checkpoints = await open();
    assert.deepEqual((await checkpoints.nested()).sort(), [join(repo, "inner"), join(repo, "sub")].sort());
  });
});

describe("baseline", () => {
  it("covers every point that has no snapshot here", async () => {
    const checkpoints = await open();
    await checkpoints.baseline();
    assert.equal(git("reflog", "show", "refs/pi/sessions/s1", "--format=%gs"), "entry=root");
    assert.ok(checkpoints.find(["anything"]));
  });

  it("leaves a repository alone that has snapshots already", async () => {
    const checkpoints = await open();
    await checkpoints.snapshot(["e1"]);
    await checkpoints.baseline();
    assert.equal(git("reflog", "show", "refs/pi/sessions/s1", "--format=%gs"), "entry=e1");
  });
});

describe("retention", () => {
  it("leaves expiry to git: snapshots are unreachable reflog entries", async () => {
    const checkpoints = await open();
    await checkpoints.snapshot(["a"]);
    write("tracked.txt", "b\n");
    await checkpoints.snapshot(["a", "b"]);
    git("reflog", "expire", "--expire-unreachable=now", "refs/pi/sessions/s1");
    assert.equal(git("reflog", "show", "refs/pi/sessions/s1", "--format=%gs"), "");
  });
});
