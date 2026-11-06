// Snapshots of the code at each point of a session, kept in git.
//
// A snapshot has the shape of `git stash push -u`: a commit of the worktree
// whose parents are HEAD, a commit of the index and, when there are any, a
// commit of the untracked files. `git stash apply --index <commit>` restores
// one by hand.
//
// One ref per session holds them. Its reflog is the list: every update names
// the entry the snapshot belongs to. The snapshots do not descend from each
// other, so git expires them like any unreachable reflog entry
// (gc.reflogExpireUnreachable, 30 days unless set for refs/pi/*).
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type RestoreMode = "worktree" | "worktree+index";

// Stands for the empty session, which has no entry to name.
export const ROOT_ENTRY = "root";

// Hashing a stray model or disk image on every turn would stall the agent.
const MAX_UNTRACKED_BYTES = 16 * 1024 * 1024;

const IDENTITY = {
  GIT_AUTHOR_NAME: "pi-tree-state",
  GIT_AUTHOR_EMAIL: "pi-tree-state@localhost",
  GIT_COMMITTER_NAME: "pi-tree-state",
  GIT_COMMITTER_EMAIL: "pi-tree-state@localhost",
};

interface RunOptions {
  env?: Record<string, string>;
  input?: string;
}

class GitError extends Error {
  readonly exitCode: unknown;

  constructor(message: string, exitCode: unknown) {
    super(message);
    this.exitCode = exitCode;
  }
}

function run(cwd: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...IDENTITY, ...options.env }, maxBuffer: 1 << 28 },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args[0]}: ${stderr.trim() || err.message}`, err.code));
        else resolve(stdout.trimEnd());
      },
    );
    child.stdin?.end(options.input);
  });
}

async function withTempIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-tree-state-"));
  try {
    return await fn({ GIT_INDEX_FILE: join(dir, "index") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class Checkpoints {
  readonly root: string;
  private readonly ref: string;
  private readonly commits = new Map<string, string>();
  private lastUndo: { commit: string; operation: string } | undefined;

  private constructor(root: string, sessionId: string) {
    this.root = root;
    this.ref = `refs/pi/sessions/${sessionId}`;
  }

  // Undefined outside a repository. The ancestors are the sessions this one
  // was forked from: entries keep their ids in a fork.
  static async open(cwd: string, sessionId: string, ancestors: string[] = []): Promise<Checkpoints | undefined> {
    let root: string;
    try {
      root = await run(cwd, ["rev-parse", "--show-toplevel"]);
    } catch {
      return undefined;
    }
    const checkpoints = new Checkpoints(root, sessionId);
    for (const id of [sessionId, ...ancestors]) await checkpoints.load(id);
    return checkpoints;
  }

  private git(args: string[], options?: RunOptions): Promise<string> {
    return run(this.root, args, options);
  }

  private async load(sessionId: string): Promise<void> {
    let log: string;
    try {
      log = await this.git(["reflog", "show", `refs/pi/sessions/${sessionId}`, "--format=%H %gs"]);
    } catch {
      return;
    }
    // Newest first, and the session's own snapshots load before its ancestors'.
    for (const line of log.split("\n")) {
      const [commit, label] = line.split(" ");
      if (label?.startsWith("entry=")) {
        const entry = label.slice("entry=".length);
        if (!this.commits.has(entry)) this.commits.set(entry, commit);
      } else if (label?.startsWith("undo=")) {
        this.lastUndo ??= { commit, operation: label.slice("undo=".length) };
      }
    }
  }

  // The repositories inside this one, which its snapshots do not cover: git
  // lists them as untracked with a trailing slash, and submodules as gitlinks.
  async nested(): Promise<string[]> {
    const others = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    const dirs = others
      .split("\0")
      .filter((name) => name.endsWith("/"))
      .map((name) => name.slice(0, -1));
    for (const line of (await this.git(["ls-files", "--stage", "-z"])).split("\0")) {
      if (line.startsWith("160000 ")) dirs.push(line.slice(line.indexOf("\t") + 1));
    }
    return dirs.map((dir) => join(this.root, dir));
  }

  private commit(tree: string, parents: string[], message: string): Promise<string> {
    return this.git(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message]);
  }

  private async untracked(): Promise<string | undefined> {
    const listed = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    const names: string[] = [];
    for (const name of listed.split("\0")) {
      // A trailing slash is a nested repository, which git cannot add as files.
      if (!name || name.endsWith("/")) continue;
      const stat = await lstat(join(this.root, name)).catch(() => undefined);
      if (stat && stat.size <= MAX_UNTRACKED_BYTES) names.push(name);
    }
    if (names.length === 0) return undefined;
    return withTempIndex(async (env) => {
      await this.git(["update-index", "--add", "-z", "--stdin"], { env, input: `${names.join("\0")}\0` });
      return this.commit(await this.git(["write-tree"], { env }), [], "untracked files");
    });
  }

  // Undefined when git cannot express the state: no commit yet, or an
  // unmerged index, which `git stash create` refuses.
  private async take(): Promise<string | undefined> {
    let head: string;
    let stash: string;
    try {
      head = await this.git(["rev-parse", "--verify", "-q", "HEAD"]);
      // Exits with 1 for no changes when it had to refresh the index to find
      // that out, as on the first run in a container.
      stash = await this.git(["stash", "create"]).catch((err: GitError) => {
        if (err.exitCode === 1) return "";
        throw err;
      });
    } catch {
      return undefined;
    }
    let index: string;
    if (stash) {
      index = `${stash}^2`;
    } else {
      // No change to tracked files: `git stash create` prints nothing.
      index = await this.commit(`${head}^{tree}`, [head], "index");
      stash = await this.commit(`${head}^{tree}`, [head, index], "worktree");
    }
    const untracked = await this.untracked();
    if (!untracked) return stash;
    return this.commit(`${stash}^{tree}`, [head, index, untracked], "worktree");
  }

  // Under a commit of its own, named after the label: the same code twice in
  // one second is the same commit, and updating a ref to its value logs nothing.
  private async record(label: string, snapshot: string): Promise<string> {
    const [, ...parents] = (await this.git(["rev-list", "--parents", "-n", "1", snapshot])).split(" ");
    const commit = await this.commit(`${snapshot}^{tree}`, parents, label);
    await this.git(["update-ref", "--create-reflog", "-m", label, this.ref, commit]);
    return commit;
  }

  // The trees that make a snapshot what it is: a commit differs by its date
  // even when nothing changed.
  private async fingerprint(commit: string): Promise<string> {
    const parents = (await this.git(["rev-list", "--parents", "-n", "1", commit])).split(" ");
    const specs = [`${commit}^{tree}`, `${commit}^2^{tree}`];
    if (parents.length > 3) specs.push(`${commit}^3^{tree}`);
    return this.git(["rev-parse", ...specs]);
  }

  // The newest snapshot on a path, which runs from the root to the entry.
  find(path: string[]): string | undefined {
    for (let i = path.length - 1; i >= 0; i--) {
      const commit = this.commits.get(path[i]);
      if (commit) return commit;
    }
    return this.commits.get(ROOT_ENTRY);
  }

  // Records the code under the last entry of the path, unless the snapshot
  // the path already leads to says the same.
  async snapshot(path: string[]): Promise<string | undefined> {
    const commit = await this.take();
    if (!commit) return undefined;
    const known = this.find(path);
    if (known && (await this.fingerprint(known)) === (await this.fingerprint(commit))) return known;
    const entry = path.at(-1) ?? ROOT_ENTRY;
    const recorded = await this.record(`entry=${entry}`, commit);
    this.commits.set(entry, recorded);
    return recorded;
  }

  // Records the code as it was before the session touched this repository, for
  // every point that has no snapshot of its own here.
  async baseline(): Promise<void> {
    if (this.commits.size > 0) return;
    const commit = await this.take();
    if (!commit) return;
    this.commits.set(ROOT_ENTRY, await this.record(`entry=${ROOT_ENTRY}`, commit));
  }

  // Whether restoring a snapshot would change anything.
  async differs(commit: string): Promise<boolean> {
    const current = await this.take();
    return !current || (await this.fingerprint(current)) !== (await this.fingerprint(commit));
  }

  // The worktree of a snapshot: the tracked files with the untracked ones.
  private async fullTree(commit: string): Promise<string> {
    const parents = (await this.git(["rev-list", "--parents", "-n", "1", commit])).split(" ");
    if (parents.length <= 3) return this.git(["rev-parse", `${commit}^{tree}`]);
    return withTempIndex(async (env) => {
      await this.git(["read-tree", `${commit}^{tree}`], { env });
      const files = await this.git(["ls-tree", "-r", "-z", `${commit}^3`]);
      await this.git(["update-index", "-z", "--index-info"], { env, input: files });
      return this.git(["write-tree"], { env });
    });
  }

  private async removeEmptyParents(name: string): Promise<void> {
    for (let dir = dirname(name); dir !== "."; dir = dirname(dir)) {
      const path = join(this.root, dir);
      const entries = await readdir(path).catch(() => undefined);
      if (!entries || entries.length > 0) return;
      await rmdir(path);
    }
  }

  // Makes the worktree match the snapshot exactly, new files removed, and with
  // worktree+index the index too. HEAD stays: a restored state on a later
  // commit shows up as changes. What it replaces is kept for undo(), under the
  // operation that a restore across repositories shares.
  async restore(commit: string, mode: RestoreMode, operation: string): Promise<void> {
    const current = await this.take();
    if (!current) throw new Error("cannot snapshot the current code, nothing restored");
    this.lastUndo = { commit: await this.record(`undo=${operation}`, current), operation };

    const [from, to] = await Promise.all([this.fullTree(current), this.fullTree(commit)]);
    const diff = await this.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]);
    const fields = diff.split("\0").filter(Boolean);
    const removed: string[] = [];
    const written: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      (fields[i] === "D" ? removed : written).push(fields[i + 1]);
    }

    // Removed first: a file can replace a directory the removed files were in.
    for (const name of removed) {
      await unlink(join(this.root, name)).catch(() => {});
      await this.removeEmptyParents(name);
    }
    if (written.length > 0) {
      await withTempIndex(async (env) => {
        await this.git(["read-tree", to], { env });
        await this.git(["checkout-index", "-f", "-z", "--stdin"], { env, input: `${written.join("\0")}\0` });
      });
    }
    if (mode === "worktree+index") await this.git(["read-tree", `${commit}^2^{tree}`]);
    // Exits 1 when files differ from the index, which is the point of a
    // worktree-only restore.
    await this.git(["update-index", "-q", "--refresh"]).catch(() => {});
  }

  get undoOperation(): string | undefined {
    return this.lastUndo?.operation;
  }

  // Returns to the code before the last restore, and is undone by itself.
  async undo(operation: string): Promise<void> {
    if (this.lastUndo) await this.restore(this.lastUndo.commit, "worktree+index", operation);
  }
}
