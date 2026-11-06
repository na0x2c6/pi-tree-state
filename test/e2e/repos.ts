// A turn that edits a nested repository and one elsewhere, through the model's
// write tool: `E2E_TOOLS=1 node test/e2e/repos.ts [model]`. Not part of
// `npm test`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, answers, asked, check, finish, open, repo, SessionManager, waitFor, work } from "./harness.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
function createRepo(dir: string) {
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "e2e");
  git(dir, "config", "user.email", "e2e@example.com");
  writeFileSync(join(dir, "a.txt"), "before\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
}

const inner = join(repo, "inner");
const other = join(work, "other");
createRepo(inner);
createRepo(other);

const manager = SessionManager.create(repo, join(agentDir, "sessions"));
const session = await open(manager);
const ref = `refs/pi/sessions/${manager.getSessionId()}`;
const reflog = (dir: string) => git(dir, "reflog", "show", ref, "--format=%gs").split("\n");
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8").trim();

await session.prompt(
  `Call the write tool twice. First, path ${join(inner, "a.txt")} with content banana. Second, path ${join(other, "a.txt")} with content banana. Then answer done.`,
);
const first = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user")!;
await waitFor("the files", () => read(inner, "a.txt") !== "before" && read(other, "a.txt") !== "before", 30_000);
const written = [read(inner, "a.txt"), read(other, "a.txt")];
console.log(`  inner: ${reflog(inner).join(" ")}\n  other: ${reflog(other).join(" ")}`);
check("the nested repository is recorded", reflog(inner).some((line) => line.startsWith("entry=")));
check("the other repository kept its state before the tool", reflog(other).at(-1) === "entry=root", reflog(other));
check("the list of repositories is on disk", existsSync(join(agentDir, "tree-state", manager.getSessionId(), "repos.json")));

answers.push("Restore worktree and index");
await session.navigateTree(first.id, { summarize: false });
console.log(`  asked: ${asked.at(-1)}`);
check("the dialog counts the repositories", asked.at(-1)?.includes("repositories"), asked);
check("the nested repository went back", read(inner, "a.txt") === "before", read(inner, "a.txt"));
check("the other repository went back", read(other, "a.txt") === "before", read(other, "a.txt"));

await session.prompt("/code-undo");
check("undo brought both forward again", read(inner, "a.txt") === written[0] && read(other, "a.txt") === written[1]);
session.dispose();
finish();
