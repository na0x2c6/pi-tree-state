// Keeps a snapshot of the code for each point of the session tree, and brings
// it back when the tree is navigated.
//
// pi's "Summarize branch?" menu is fixed, so the choice about the code is a
// second dialog after it: 3 x 3 combinations instead of a longer list.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RestoreMode } from "../src/checkpoint.ts";
import { ancestorSessions } from "../src/storage.ts";
import { type PlannedRestore, Workspace } from "../src/workspace.ts";

const KEEP = "Keep current code";
const RESTORE_WORKTREE = "Restore worktree";
const RESTORE_BOTH = "Restore worktree and index";
const CANCEL = "Cancel navigation";

const NOTE_RESTORED =
  "Note: the code was restored to the point returned to. The changes made in the summarized branch are no longer in the files.";
const NOTE_KEPT =
  "Note: the code was kept. The changes made in the summarized branch are still in the files, although the conversation no longer shows them.";

// As pi's tools read their path argument, which its package does not export.
function toolPath(path: string, cwd: string): string {
  const plain = path.startsWith("@") ? path.slice(1) : path;
  return resolve(cwd, plain.replace(/^~(?=\/|$)/, homedir()));
}

export default function (pi: ExtensionAPI) {
  let workspace: Workspace | undefined;
  let runStarting = false;
  let pending: { planned: PlannedRestore[]; mode: RestoreMode } | undefined;

  const pathTo = (ctx: ExtensionContext, id: string | null | undefined): string[] =>
    id ? ctx.sessionManager.getBranch(id).map((entry) => entry.id) : [];

  const snapshot = async (ctx: ExtensionContext) => {
    try {
      await workspace?.snapshot(pathTo(ctx, ctx.sessionManager.getLeafId()));
    } catch (err) {
      ctx.ui.notify(`code snapshot failed: ${err}`, "warning");
    }
  };

  // Asks what to do with the code of a point. Undefined means leave it, and
  // "cancel" that the user backed out.
  const askRestore = async (ctx: ExtensionContext, repos: number): Promise<RestoreMode | "cancel" | undefined> => {
    const title = repos > 1 ? `Restore code in ${repos} repositories?` : "Restore code?";
    const choice = await ctx.ui.select(title, [KEEP, RESTORE_WORKTREE, RESTORE_BOTH, CANCEL]);
    if (choice === RESTORE_WORKTREE) return "worktree";
    if (choice === RESTORE_BOTH) return "worktree+index";
    return choice === KEEP ? undefined : "cancel";
  };

  const applyRestore = async (ctx: ExtensionContext, planned: PlannedRestore[], mode: RestoreMode) => {
    const failed = (await workspace?.restore(planned, mode)) ?? [];
    if (failed.length > 0) ctx.ui.notify(`code restore failed:\n${failed.join("\n")}`, "error");
    if (failed.length < planned.length) ctx.ui.notify(`code restored (${mode}), /code-undo goes back`, "info");
  };

  pi.on("session_start", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const ancestors = await ancestorSessions(ctx.sessionManager.getHeader());
    workspace = await Workspace.open(ctx.cwd, join(getAgentDir(), "tree-state"), id, ancestors);
  });

  pi.on("before_agent_start", () => {
    runStarting = true;
  });

  // The user message is an entry by now, unlike in before_agent_start, and
  // nothing has touched the code yet.
  pi.on("context", async (_event, ctx) => {
    if (!runStarting) return;
    runStarting = false;
    await snapshot(ctx);
  });

  // Bash can change files too, but its command does not say which.
  pi.on("tool_call", async (event, ctx) => {
    const { path } = event.input as { path?: unknown };
    if ((event.toolName !== "edit" && event.toolName !== "write") || typeof path !== "string") return;
    await workspace?.track(toolPath(path, ctx.cwd)).catch((err) => {
      ctx.ui.notify(`code snapshot failed: ${err}`, "warning");
    });
  });

  pi.on("turn_end", async (_event, ctx) => {
    await snapshot(ctx);
  });

  pi.on("session_before_tree", async (event, ctx) => {
    pending = undefined;
    const { preparation } = event;

    const planned = ctx.hasUI ? await workspace?.plan(pathTo(ctx, preparation.targetId)) : undefined;
    if (!planned?.length) return;
    const mode = await askRestore(ctx, planned.length);
    if (mode === "cancel") return { cancel: true };
    // Applied in session_tree: the summary can still be cancelled.
    if (mode) pending = { planned, mode };
    const note = mode ? NOTE_RESTORED : NOTE_KEPT;

    // For an extension that writes the summary itself. pi runs every handler
    // and keeps the last result, so the one below stands if none does.
    pi.events.emit("tree-state:code-note", note);
    if (!preparation.userWantsSummary || preparation.replaceInstructions) return;
    const parts = [preparation.customInstructions, `End the summary with this sentence: ${note}`];
    return { customInstructions: parts.filter(Boolean).join("\n\n") };
  });

  pi.on("session_tree", async (_event, ctx) => {
    const restore = pending;
    pending = undefined;
    if (restore) await applyRestore(ctx, restore.planned, restore.mode);
  });

  // Nothing after this hook to hold the restore back to: the fork replaces
  // this runtime.
  pi.on("session_before_fork", async (event, ctx) => {
    const planned = ctx.hasUI ? await workspace?.plan(pathTo(ctx, event.entryId)) : undefined;
    if (!planned?.length) return;
    const mode = await askRestore(ctx, planned.length);
    if (mode === "cancel") return { cancel: true };
    if (mode) await applyRestore(ctx, planned, mode);
  });

  pi.registerCommand("code-undo", {
    description: "Go back to the code before the last restore of tree-state",
    handler: async (_args, ctx) => {
      const done = await workspace?.undo();
      ctx.ui.notify(done ? "code back to before the last restore" : "no restore to undo", "info");
    },
  });

  pi.registerCommand("tree-state", {
    description: "Show where tree-state keeps this session's code",
    handler: async (_args, ctx) => {
      const id = ctx.sessionManager.getSessionId();
      const repos = workspace?.roots.join("\n  ") || "no git repository";
      ctx.ui.notify(`code: git reflog refs/pi/sessions/${id}, in\n  ${repos}`, "info");
    },
  });
}
