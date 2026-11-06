import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ancestorSessions } from "../src/storage.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "storage-test-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ancestorSessions", () => {
  it("follows parentSession up to the first session", async () => {
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    writeFileSync(first, `${JSON.stringify({ id: "s1" })}\n{}\n`);
    writeFileSync(second, `${JSON.stringify({ id: "s2", parentSession: first })}\n`);
    assert.deepEqual(await ancestorSessions({ id: "s3", parentSession: second }), ["s2", "s1"]);
  });

  it("stops at a parent that is gone", async () => {
    assert.deepEqual(await ancestorSessions({ parentSession: join(root, "gone.jsonl") }), []);
  });

  it("has nothing for a session without a parent", async () => {
    assert.deepEqual(await ancestorSessions({ id: "s1" }), []);
    assert.deepEqual(await ancestorSessions(null), []);
  });
});
