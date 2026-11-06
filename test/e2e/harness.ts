// The throwaway repository, agent directory and scripted UI of the e2e runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const modelId = process.argv[2] ?? "sharp-spark-x2.5-4b";
export const serverUrl = process.env.LLAMA_URL ?? "http://127.0.0.1:8081";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extra = process.env.E2E_EXTENSIONS?.split(":").filter(Boolean) ?? [];

export const work = mkdtempSync(join(tmpdir(), "pi-tree-state-e2e-"));
export const agentDir = join(work, "agent");
export const repo = join(work, "repo");
mkdirSync(agentDir);
mkdirSync(repo);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const pi = await import("@earendil-works/pi-coding-agent");
export const { SessionManager } = pi;

export const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trimEnd();
export const write = (name: string, text: string) => writeFileSync(join(repo, name), text);
export const read = (name: string) => readFileSync(join(repo, name), "utf8");

git("init", "-q", "-b", "main");
git("config", "user.name", "e2e");
git("config", "user.email", "e2e@example.com");
write("code.txt", "v0\n");
git("add", ".");
git("commit", "-qm", "base");

function writeModels(baseUrl: string) {
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        llamacpp: {
          name: "llama-server",
          baseUrl: `${baseUrl}/v1`,
          api: "openai-completions",
          apiKey: "none",
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: true,
            supportsStrictMode: false,
            maxTokensField: "max_tokens",
            thinkingFormat: "chat-template",
            chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
          },
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: true,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 2048,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
}

let failures = 0;
export function check(name: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

export function finish(): never {
  console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

export const status: string[] = [];
export const notes: string[] = [];
export const answers: string[] = [];
export const asked: string[] = [];

const ui = new Proxy(
  {
    select: async (title: string) => {
      asked.push(title);
      return answers.shift();
    },
    notify: (text: string) => {
      notes.push(text);
      console.log(`  notify: ${text}`);
    },
    setStatus: (_key: string, text: string | undefined) => {
      if (text) status.push(text);
    },
  } as Record<string | symbol, unknown>,
  { get: (target, key) => target[key] ?? (() => undefined) },
);

export async function open(sessionManager: ReturnType<typeof SessionManager.create>, baseUrl = serverUrl) {
  writeModels(baseUrl);
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const model = modelRuntime.getModel("llamacpp", modelId);
  assert.ok(model, "model not found");
  const settingsManager = pi.SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: repo,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [
      join(repoDir, "extensions/tree-state.ts"),
      ...extra,
    ],
  });
  await resourceLoader.reload();
  const { session } = await pi.createAgentSession({
    cwd: repo,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    noTools: process.env.E2E_TOOLS ? undefined : "all",
    sessionManager,
    settingsManager,
  });
  await session.bindExtensions({ uiContext: ui as never, mode: "tui" as never });
  return session;
}

export async function waitFor(what: string, test: () => boolean, ms = 180_000) {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}, last status: ${status.slice(-3).join(" | ")}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  return Date.now() - start;
}
