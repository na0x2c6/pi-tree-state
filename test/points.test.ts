import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Entry, entryByPrefix, restorePoints } from "../src/points.ts";

let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, clock++)).toISOString();
const user = (id: string, parentId: string | null, content: unknown): Entry => ({
  type: "message",
  id,
  parentId,
  timestamp: at(),
  message: { role: "user", content },
});
const reply = (id: string, parentId: string): Entry => ({
  type: "message",
  id,
  parentId,
  timestamp: at(),
  message: { role: "assistant", content: [] },
});

// u1 ─ a1 ─ u2 ─ a2      (left)
//         └ u3 ─ a3      (current)
const tree = () => {
  clock = 0;
  return [
    user("u1", null, "first"),
    reply("a1", "u1"),
    user("u2", "a1", [{ type: "text", text: "left\nbranch" }]),
    reply("a2", "u2"),
    user("u3", "a1", "right"),
    reply("a3", "u3"),
  ];
};

describe("restorePoints", () => {
  it("offers each user message and each branch end, newest first", () => {
    const points = restorePoints(tree(), new Set(["u1", "a1", "u3", "a3"]));
    assert.deepEqual(
      points.map((point) => point.id),
      ["a3", "u3", "a2", "u2", "u1"],
    );
  });

  it("names a branch end after its last user message", () => {
    const [end] = restorePoints(tree(), new Set());
    assert.match(end.title, /a3 +end: +right$/);
    const left = restorePoints(tree(), new Set()).find((point) => point.id === "a2");
    assert.match(left?.title ?? "", /end: +left branch$/);
  });

  it("marks the points of the current branch", () => {
    const points = restorePoints(tree(), new Set(["u1", "a1", "u3", "a3"]));
    const marked = points.filter((point) => point.title.startsWith("*")).map((point) => point.id);
    assert.deepEqual(marked, ["a3", "u3", "u1"]);
  });

  it("offers an unanswered message once", () => {
    clock = 0;
    const points = restorePoints([user("u1", null, "waiting")], new Set());
    assert.equal(points.length, 1);
    assert.match(points[0].title, /sent: waiting$/);
  });

  it("shortens a long message to one line", () => {
    clock = 0;
    const [point] = restorePoints([user("u1", null, `${"x".repeat(100)}`)], new Set());
    assert.match(point.title, /sent: x{59}…$/);
  });
});

describe("entryByPrefix", () => {
  it("finds the entry a prefix names", () => {
    const entries = [user("abc1", null, ""), user("abd2", "abc1", "")];
    assert.equal((entryByPrefix(entries, "abc") as Entry).id, "abc1");
  });

  it("says why it found none", () => {
    const entries = [user("abc1", null, ""), user("abd2", "abc1", "")];
    assert.equal(entryByPrefix(entries, "ab"), "2 entries start with ab");
    assert.equal(entryByPrefix(entries, "x"), "no entry starts with x");
  });
});
