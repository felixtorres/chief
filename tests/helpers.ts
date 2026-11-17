import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../src/config.js";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
export const FAKE_AZ = fileURLToPath(new URL("./fixtures/fake-az.mjs", import.meta.url));

for (const [k, v] of Object.entries({
  GIT_AUTHOR_NAME: "Chief Test",
  GIT_AUTHOR_EMAIL: "chief@test.local",
  GIT_COMMITTER_NAME: "Chief Test",
  GIT_COMMITTER_EMAIL: "chief@test.local",
})) process.env[k] = v;

export function tmp(prefix = "chief-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return repo;
}

export function makeConfig(root: string, repo: string, overrides: Record<string, unknown> = {}): Config {
  const fakeState = join(root, "fake");
  mkdirSync(fakeState, { recursive: true });
  process.env.FAKE_STATE = fakeState;
  return parseConfig({
    boardPath: join(root, "board.md"),
    stateFile: join(root, "state", "state.json"),
    ledgerFile: join(root, "state", "ledger.jsonl"),
    recipesFile: join(root, "state", "recipes.json"),
    learnedFile: join(root, "config", "learned.json"),
    worktreesDir: join(root, "worktrees"),
    digestDir: join(root, "digests"),
    runsDir: join(root, "runs"),
    tracesDir: join(root, "traces"),
    claudeCmd: [process.execPath, FAKE_CLAUDE],
    azCmd: [process.execPath, FAKE_AZ],
    openPr: false,
    fetchBeforeBranch: false,
    defaultRepo: "demo",
    repos: { demo: { path: repo, testCmd: "test -f feature.txt" } },
    ...overrides,
  });
}

export interface FakeCall {
  args: string[];
  cwd: string;
  prompt: string;
}

export function fakeCalls(): FakeCall[] {
  const file = join(process.env.FAKE_STATE!, "calls.jsonl");
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeCall);
  } catch {
    return [];
  }
}

export function resetFakeEnv(): void {
  delete process.env.FAKE_WORKER;
  delete process.env.FAKE_REVIEW;
  delete process.env.FAKE_DENY;
  delete process.env.FAKE_REFLECT;
  delete process.env.FAKE_AZ_PR;
}
