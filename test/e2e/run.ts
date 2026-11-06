// Runs the extension on a real session: `node test/e2e/run.ts [model]`, against
// any server of the model. Not part of `npm test`.
import { join } from "node:path";
import {
  agentDir,
  answers,
  asked,
  check,
  finish,
  git,
  open,
  read,
  repo,
  SessionManager,
  work,
  write,
} from "./harness.ts";

const manager = SessionManager.create(repo, join(agentDir, "sessions"));
const session = await open(manager);
const id = manager.getSessionId();
const ref = `refs/pi/sessions/${id}`;

const messages = () =>
  manager.getEntries().filter((entry) => entry.type === "message") as { id: string; message: { role: string } }[];
const lastOf = (role: string) => messages().filter((entry) => entry.message.role === role).at(-1)!.id;

console.log(`session ${id}\nwork ${work}`);

// Two turns, each on its own state of the code.
write("code.txt", "v1 staged\n");
git("add", "code.txt");
write("code.txt", "v1 staged\nv1 unstaged\n");
write("new.txt", "untracked at v1\n");
await session.prompt("Say hello in one short sentence.");
const user1 = lastOf("user");
const assistant1 = lastOf("assistant");
check("reflog names the user message", git("reflog", "show", ref, "--format=%gs").includes(`entry=${user1}`));

write("code.txt", "v2\n");
git("add", "code.txt");
await session.prompt("Say goodbye in one short sentence.");
const user2 = lastOf("user");
const assistant2 = lastOf("assistant");

// Back to the second prompt, worktree only: the staged state stays.
write("code.txt", "v3 worktree\n");
git("add", "code.txt");
write("code.txt", "v3 worktree\nv3 unstaged\n");
const stagedBefore = git("show", ":code.txt");
answers.push("Restore worktree");
await session.navigateTree(user2, { summarize: false });
check("the dialog was asked", asked.at(-1) === "Restore code?", asked);
check("worktree restored to the second prompt", read("code.txt") === "v2\n", read("code.txt"));
check("index left alone", git("show", ":code.txt") === stagedBefore);
check("leaf moved to the first reply", manager.getLeafId() === assistant1);

// A new branch from there, then back further with pi's summary and both areas.
write("code.txt", "v4 branch\n");
await session.prompt("Say thanks in one short sentence.");
answers.push("Restore worktree and index");
await session.navigateTree(user1, { summarize: true });
const branchSummary = manager.getEntries().filter((entry) => entry.type === "branch_summary").at(-1) as
  | { summary: string; fromHook?: boolean }
  | undefined;
check("the branch summary is pi's", branchSummary !== undefined && !branchSummary.fromHook, branchSummary);
check("worktree restored to the first prompt", read("code.txt") === "v1 staged\nv1 unstaged\n", read("code.txt"));
check("index restored to the first prompt", git("show", ":code.txt") === "v1 staged");
check("untracked file came back", read("new.txt") === "untracked at v1\n");

// Cancelling leaves everything where it is.
write("code.txt", "v5\n");
const leafBefore = manager.getLeafId();
answers.push("Cancel navigation");
const cancelled = await session.navigateTree(assistant2, { summarize: false });
check("cancel keeps the position", cancelled.cancelled && manager.getLeafId() === leafBefore);
check("cancel keeps the code", read("code.txt") === "v5\n");

// Back to the abandoned branch with the code kept.
answers.push("Keep current code");
await session.navigateTree(assistant2, { summarize: false });
check("the code is kept", read("code.txt") === "v5\n");

session.dispose();
finish();
