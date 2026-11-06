// The repositories a session touches. A session can reach beyond the one it
// started in: a repository nested in it, a submodule, or a file anywhere else.
// Each keeps its own snapshots under the same entry ids, so that one point of
// the conversation means one state of all of them.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Checkpoints, type RestoreMode } from "./checkpoint.ts";

export interface PlannedRestore {
  repo: Checkpoints;
  commit: string;
}

export class Workspace {
  private readonly repos = new Map<string, Promise<Checkpoints>>();
  private readonly sessionId: string;
  private readonly ancestors: string[];
  private readonly file: string;

  private constructor(file: string, sessionId: string, ancestors: string[]) {
    this.file = file;
    this.sessionId = sessionId;
    this.ancestors = ancestors;
  }

  static async open(cwd: string, root: string, sessionId: string, ancestors: string[] = []): Promise<Workspace> {
    await mkdir(join(root, sessionId), { recursive: true });
    const workspace = new Workspace(join(root, sessionId, "repos.json"), sessionId, ancestors);
    const opened = await Checkpoints.open(cwd, sessionId, ancestors);
    // The first turn takes this one's first snapshot before anything changes.
    if (opened) workspace.repos.set(opened.root, Promise.resolve(opened));
    for (const id of [sessionId, ...ancestors]) {
      const text = await readFile(join(root, id, "repos.json"), "utf8").catch(() => "[]");
      for (const dir of JSON.parse(text) as string[]) await workspace.add(dir);
    }
    return workspace;
  }

  private async add(dir: string): Promise<Checkpoints | undefined> {
    const repo = await Checkpoints.open(dir, this.sessionId, this.ancestors);
    if (!repo) return undefined;
    // No await between the check and the set: parallel tool calls land here.
    const known = this.repos.get(repo.root);
    if (known) return known;
    const ready = repo.baseline().then(() => repo);
    this.repos.set(repo.root, ready);
    await ready;
    await writeFile(this.file, JSON.stringify([...this.repos.keys()]));
    return repo;
  }

  private all(): Promise<Checkpoints[]> {
    return Promise.all(this.repos.values());
  }

  get roots(): string[] {
    return [...this.repos.keys()];
  }

  // Called before a tool changes a file, while its repository can still be
  // recorded as it was.
  async track(file: string): Promise<void> {
    let dir = dirname(file);
    while (!(await stat(dir).catch(() => undefined)) && dirname(dir) !== dir) dir = dirname(dir);
    await this.add(dir);
  }

  // Finds what a bash command may have changed too, within the repositories
  // that are known. A repository found this way is recorded as it is by now.
  private async discover(): Promise<Checkpoints[]> {
    const repos = await this.all();
    for (let i = 0; i < repos.length; i++) {
      for (const dir of await repos[i].nested().catch(() => [] as string[])) {
        const repo = await this.add(dir);
        if (repo && !repos.some((other) => other.root === repo.root)) repos.push(repo);
      }
    }
    return repos;
  }

  async snapshot(path: string[]): Promise<void> {
    for (const repo of await this.discover()) await repo.snapshot(path);
  }

  // What going to the end of the path would change.
  async plan(path: string[]): Promise<PlannedRestore[]> {
    const planned: PlannedRestore[] = [];
    for (const repo of await this.all()) {
      const commit = repo.find(path);
      if (commit && (await repo.differs(commit))) planned.push({ repo, commit });
    }
    return planned;
  }

  // Goes on after a failure: leaving the other repositories behind would not
  // bring the failed one back. Returns what failed.
  async restore(planned: PlannedRestore[], mode: RestoreMode): Promise<string[]> {
    const operation = String(Date.now());
    const failed: string[] = [];
    for (const { repo, commit } of planned) {
      await repo.restore(commit, mode, operation).catch((err) => failed.push(`${repo.root}: ${err.message}`));
    }
    return failed;
  }

  // Returns the repositories of the last restore to the code before it.
  async undo(): Promise<boolean> {
    const repos = await this.all();
    const last = Math.max(...repos.map((repo) => Number(repo.undoOperation ?? 0)), 0);
    if (last === 0) return false;
    const operation = String(Date.now());
    for (const repo of repos) {
      if (Number(repo.undoOperation) === last) await repo.undo(operation);
    }
    return true;
  }
}
