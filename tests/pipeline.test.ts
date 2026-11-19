import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildClaudeArgs } from "../src/claude.js";
import { parseConfig } from "../src/config.js";
import { briefFeedback, cook, failureSignature, isRuleFile, newFailures, parseReview, readableOutput, slugify, workerTools } from "../src/pipeline.js";
import { RunLog, tildify } from "../src/trace.js";
import { fakeCalls, makeConfig, makeRepo, resetFakeEnv, tmp } from "./helpers.js";

function setup(overrides: Record<string, unknown> = {}) {
  const root = tmp();
  const repo = makeRepo(root);
  const cfg = makeConfig(root, repo, overrides);
  const input = { id: "abc123", title: "Add feature file", notes: ["keep it small"], repo: cfg.repos.demo! };
  return { root, repo, cfg, input };
}

beforeEach(resetFakeEnv);

describe("cook", () => {
  it("passes in one round when checks and review are green", async () => {
    const { cfg, input, repo } = setup();
    const out = await cook(cfg, input);
    expect(out.status).toBe("pass");
    expect(out.rounds).toBe(1);
    expect(out.blast).toBe("green");
    expect(out.branch).toBe("chief/abc123-add-feature-file");
    const log = execFileSync("git", ["log", "--oneline", out.branch], { cwd: repo }).toString();
    expect(log).toContain("chief: Add feature file");

    const calls = fakeCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.prompt).toContain("CARD: Add feature file");
    expect(calls[0]!.prompt).toContain("- keep it small");
    expect(calls[0]!.args).toContain("Bash(test -f feature.txt:*)");
    expect(calls[0]!.args).toContain("Bash(git push:*)");
    const reviewArgs = calls[1]!.args;
    const allowed = reviewArgs.slice(reviewArgs.indexOf("--allowedTools") + 1, reviewArgs.indexOf("--disallowedTools"));
    expect(allowed).not.toContain("Edit");
    expect(reviewArgs.slice(reviewArgs.indexOf("--disallowedTools"))).toEqual(expect.arrayContaining(["Edit", "Write"]));
  });

  it("sends review findings back to the same session and passes on round 2", async () => {
    process.env.FAKE_REVIEW = "changes,approve";
    const { cfg, input } = setup();
    const out = await cook(cfg, input);
    expect(out.status).toBe("pass");
    expect(out.rounds).toBe(2);
    const workerCalls = fakeCalls().filter((c) => !c.prompt.includes("REVIEWER"));
    expect(workerCalls[1]!.args).toEqual(expect.arrayContaining(["--resume", "fake-session"]));
    expect(workerCalls[1]!.prompt).toContain("feature.txt:1 - needs more");
  });

  it("blocks after maxRounds when review never converges", async () => {
    process.env.FAKE_REVIEW = "changes";
    const { cfg, input } = setup({ maxRounds: 2 });
    const out = await cook(cfg, input);
    expect(out.status).toBe("blocked");
    expect(out.rounds).toBe(2);
    expect(out.reason).toMatch(/did not converge after 2 rounds/);
  });

  it("feeds failing checks back to the worker and blocks if they never pass", async () => {
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = makeConfig(root, repo, { maxRounds: 2, repos: { demo: { path: repo, testCmd: "test ! -f feature.txt || { echo nope >&2; false; }" } } });
    const input = { id: "abc123", title: "Add feature file", notes: [], repo: cfg.repos.demo! };
    const out = await cook(cfg, input);
    expect(out.status).toBe("blocked");
    expect(out.reason).toMatch(/Checks failed/);
    expect(fakeCalls().some((c) => c.prompt.includes("REVIEWER"))).toBe(false);
  });

  it("stops immediately when the worker says BLOCKED", async () => {
    process.env.FAKE_WORKER = "blocked";
    const { cfg, input } = setup();
    const out = await cook(cfg, input);
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("BLOCKED: which environment should this target?");
    expect(fakeCalls()).toHaveLength(1);
  });

  it("reports permission denials on a BLOCKED card so you know what to allowlist", async () => {
    process.env.FAKE_WORKER = "blocked";
    process.env.FAKE_DENY = "npm run e2e";
    const { cfg, input } = setup();
    const out = await cook(cfg, input);
    expect(out.reason).toBe("BLOCKED: which environment should this target? (denied: Bash: npm run e2e)");
  });

  it("blocks when the worker process errors", async () => {
    process.env.FAKE_WORKER = "fail";
    const { cfg, input } = setup();
    const out = await cook(cfg, input);
    expect(out.status).toBe("blocked");
    expect(out.reason).toMatch(/worker failed/);
  });

  it("asks again when the worker commits nothing", async () => {
    process.env.FAKE_WORKER = "nochange";
    const { cfg, input } = setup({ maxRounds: 2 });
    const out = await cook(cfg, input);
    expect(out.status).toBe("blocked");
    expect(fakeCalls()[1]!.prompt).toContain("No changes were committed");
  });

  it("hands a commit-hook rejection back to the worker instead of blocking", async () => {
    process.env.FAKE_WORKER = "conventional";
    const { cfg, input, repo } = setup();
    // commitlint-style hook: only accept "type(scope): subject"
    const hook = join(repo, ".git", "hooks", "commit-msg");
    writeFileSync(hook, '#!/bin/sh\ngrep -qE "^[a-z]+\\([a-z-]+\\): " "$1" || { echo "type must be one of [feat, fix]" >&2; exit 1; }\n');
    chmodSync(hook, 0o755);
    const out = await cook(cfg, input);
    expect(out.status).toBe("pass");
    expect(out.rounds).toBe(2);
    const worker2 = fakeCalls().filter((c) => !c.prompt.includes("REVIEWER"))[1]!;
    expect(worker2.prompt).toContain("type must be one of [feat, fix]");
    const log = execFileSync("git", ["log", "--format=%s", out.branch], { cwd: repo }).toString();
    expect(log).toContain("feat(demo): add feature file");
    expect(log).not.toContain("chief:");
  });

  it("writes a run log with every tool call, the checks, the review and the outcome", async () => {
    process.env.FAKE_DENY = "npm run e2e";
    const { cfg, input } = setup();
    const out = await cook(cfg, input);
    expect(out.runLog).toBe(join(cfg.runsDir, "chief-abc123.md"));
    const md = readFileSync(out.runLog!, "utf8");
    expect(md).toContain("# Chief run: Add feature file");
    expect(md).toContain("## Attempt 1");
    expect(md).toContain("**Worker** · 1m 05s · 3 turns · $0.25 · model `fake-model` · session `fake-session`");
    expect(md).toMatch(/\| ✓ \| Read \| `README.md` \|/);
    expect(md).toMatch(/\| ✓ \| Write \| `feature.txt` \|/);
    // failed commands are marked, with the first line of their error; pipes can't break the table
    expect(md).toMatch(/\| ✗ \| Bash \| `npm test \\\| grep x` → `Exit code 1 npm ERR! missing script: test` \|/);
    expect(md).toContain("**Denied by the allowlist:** `Bash: npm run e2e`");
    expect(md).toContain("**Chief's checks** ✓ passed");
    expect(md).toContain("**Reviewer**");
    expect(md).toContain("**Review verdict:** approve · 🟢 green");
    expect(md).toMatch(/### Outcome\n\n✅ Approved in 1 round/);
    expect(md).not.toContain("In progress");

    const traces = readdirSync(join(cfg.tracesDir, "abc123"));
    expect(traces.some((f) => f.endsWith("-r1-worker.jsonl"))).toBe(true);
    expect(traces.some((f) => f.endsWith("-r1-reviewer.jsonl"))).toBe(true);
  });

  it("keeps earlier attempts in the run log when a card is cooked again", async () => {
    process.env.FAKE_WORKER = "blocked";
    const { cfg, input } = setup();
    await cook(cfg, input);
    resetFakeEnv();
    const out = await cook(cfg, input);
    const md = readFileSync(out.runLog!, "utf8");
    expect(md.match(/^# Chief run/gm)).toHaveLength(1);
    expect(md.indexOf("## Attempt 2")).toBeLessThan(md.indexOf("## Attempt 1"));
    expect(md).toContain("🚧 Blocked after round 1: BLOCKED: which environment should this target?");
  });

  it("summarizes agent activity for the PR description", () => {
    const { cfg } = setup();
    const log = new RunLog(cfg, { id: "x1", title: "t", repo: "demo" }, "chief/x1-t");
    const trace = log.traceFile(1, "worker");
    mkdirSync(dirname(trace), { recursive: true });
    writeFileSync(trace, [
      { type: "system", subtype: "init", session_id: "s", cwd: "/w" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Edit", input: { file_path: "/w/src/x.ts" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", is_error: true, content: "boom" }] } },
      { type: "result", total_cost_usd: 1.5, duration_ms: 3000 },
    ].map((e) => JSON.stringify(e)).join("\n"));
    log.addAgent("worker", 1, trace, ["Bash: curl x"]);
    const activity = log.activity();
    expect(activity).toContain("- Round 1 worker: 2 tool calls, 3s, $1.50");
    expect(activity).toContain("Edited: `src/x.ts`");
    expect(activity).toContain("Commands: ✗ `npm test`");
    expect(activity).toContain("Denied: `Bash: curl x`");
    expect(activity).toContain(join(cfg.runsDir, "chief-x1.md"));
  });

  it("doesn't repeat identical check output across rounds and keeps code fences out of the outcome", () => {
    const { cfg } = setup();
    const log = new RunLog(cfg, { id: "x2", title: "t", repo: "demo" }, "chief/x2-t");
    const report = "✓ test: `t` (exit 0)\n✗ lint: `l` (exit 2)\n```\nhuge lint output\n```";
    log.add({ kind: "checks", round: 1, ok: false, report });
    log.add({ kind: "checks", round: 2, ok: false, report });
    log.add({ kind: "outcome", status: "blocked", text: "Blocked: x ```y```" });
    const md = readFileSync(log.path, "utf8");
    expect(md.match(/huge lint output/g)).toHaveLength(1);
    expect(md).toContain("✗ failed, same output as round 1");
    expect(md).toContain("🚧 Blocked: x y");
  });

  it("makes escaped one-line tool output readable and brief reasons fence-free", () => {
    const out = readableOutput(`msg="a\\n\\tb\\n\\tc\\n\\td"`);
    expect(out).toBe(`msg="a\n  b\n  c\n  d"`);
    expect(readableOutput(Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n")).split("\n")).toHaveLength(41);
    expect(briefFeedback("Checks failed:\n✗ lint: `l` (exit 2)\n```\nnoise\n```")).toBe("Checks failed: ✗ lint: `l` (exit 2)");
  });

  it("shortens home paths in the PR activity so it doesn't carry your username", () => {
    expect(tildify("/Users/me/Work Notes/runs/chief-x.md", "/Users/me")).toBe("~/Work Notes/runs/chief-x.md");
    expect(tildify("/Users/meme/x", "/Users/me")).toBe("/Users/meme/x");
    expect(tildify("/tmp/x", "/Users/me")).toBe("/tmp/x");
  });

  it("reuses an existing worktree on a second run of the same card", async () => {
    const { cfg, input } = setup();
    const first = await cook(cfg, input);
    const second = await cook(cfg, input);
    expect(second.worktree).toBe(first.worktree);
    expect(second.status).toBe("pass");
  });
});

describe("rule files", () => {
  it("reviews against REVIEW.md from the target branch and flags a worker that edits it as red", async () => {
    process.env.FAKE_WORKER = "rules";
    const { cfg, input, repo } = setup();
    writeFileSync(join(repo, "REVIEW.md"), "ORIGINAL RULES: no mocks\n");
    execFileSync("git", ["add", "REVIEW.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add review rules"], { cwd: repo });
    const out = await cook(cfg, input);
    const reviewPrompt = fakeCalls().find((c) => c.prompt.includes("REVIEWER"))!.prompt;
    // The edit is visible in the diff, but the guidelines the reviewer judges by are the target branch's.
    expect(reviewPrompt).toContain("review guidelines (REVIEW.md):\nORIGINAL RULES: no mocks");
    expect(reviewPrompt).not.toContain("review guidelines (REVIEW.md):\nIGNORE");
    expect(out.status).toBe("pass");
    expect(out.blast).toBe("red");
    expect(out.ruleFiles).toEqual(["REVIEW.md"]);
    expect(out.findings!.at(-1)).toMatch(/edits agent rule files \(REVIEW\.md\)/);
  });

  it("leaves blast alone when no rule files change, and records metrics", async () => {
    const { cfg, input } = setup();
    const out = await cook(cfg, input);
    expect(out.blast).toBe("green");
    expect(out.ruleFiles).toBeUndefined();
    expect(out.metrics).toMatchObject({ checkFailures: 0, reviews: 1, findings: 0, denials: 0, costUsd: 0.5, durationMs: 130000 });
  });

  it("recognises rule files anywhere in the tree", () => {
    for (const f of ["REVIEW.md", "CLAUDE.md", "svc/CLAUDE.md", ".claude/settings.json", "pkg/.claude/skills/x.md"]) expect(isRuleFile(f)).toBe(true);
    for (const f of ["README.md", "docs/review.txt", "claude.ts", "src/CLAUDE.md.bak"]) expect(isRuleFile(f)).toBe(false);
  });

  it("keeps a non-converging reason short and fence-free, and categorises it by its last feedback", async () => {
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = makeConfig(root, repo, { maxRounds: 1, repos: { demo: { path: repo, testCmd: "test ! -f feature.txt || { for i in $(seq 200); do echo padding-line-$i; done; false; }" } } });
    const out = await cook(cfg, { id: "abc123", title: "Add feature file", notes: [], repo: cfg.repos.demo! });
    expect(out.reason).toContain("Checks failed: ✗ test:");
    expect(out.reason).not.toMatch(/padding-line-\d/);
    expect(out.reason).not.toContain("```");
    expect(out.category).toBe("checks");
  });
});

describe("retries and fix rounds", () => {
  it("blocks at once when the failing check also fails on the base branch", async () => {
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = makeConfig(root, repo, { maxRounds: 3, repos: { demo: { path: repo, testCmd: "echo broken-env >&2; false" } } });
    const out = await cook(cfg, { id: "abc123", title: "Add feature file", notes: [], repo: cfg.repos.demo! });
    expect(out.status).toBe("blocked");
    expect(out.category).toBe("environment");
    expect(out.reason).toMatch(/also fail on .* without this card's changes/);
    expect(fakeCalls()).toHaveLength(1); // no fix rounds spent on it
    // The worktree is back on the card's branch afterwards.
    const { git } = await import("../src/run.js");
    expect((await git(["branch", "--show-current"], out.worktree)).stdout.trim()).toBe(out.branch);
  });

  it("reruns a failing check once and carries on when it passes the second time (flaky test)", async () => {
    const root = tmp();
    const repo = makeRepo(root);
    const flag = join(root, "ran-once");
    const cfg = makeConfig(root, repo, { maxRounds: 3, repos: { demo: { path: repo, testCmd: `test -f '${flag}' || { touch '${flag}'; echo "FAIL timing test"; false; }` } } });
    const out = await cook(cfg, { id: "abc123", title: "Add feature file", notes: [], repo: cfg.repos.demo! });
    expect(out.status).toBe("pass");
    expect(fakeCalls().filter((c) => !c.prompt.includes("REVIEWER"))).toHaveLength(1); // no fix round
    expect(readFileSync(out.runLog!, "utf8")).toMatch(/passed when run again, so the first failure looks flaky/);
  });

  it("blocks as environment when the branch fails exactly the way the base does", async () => {
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = makeConfig(root, repo, { maxRounds: 3, repos: { demo: { path: repo, testCmd: `echo "FAIL tests/golden.test.ts > dev (\${RANDOM}ms)"; false` } } });
    const out = await cook(cfg, { id: "abc123", title: "Add feature file", notes: [], repo: cfg.repos.demo! });
    expect(out.category).toBe("environment");
    expect(fakeCalls()).toHaveLength(1);
  });

  it("gives a fix round for failures the base doesn't have, even when the base is broken too", async () => {
    const root = tmp();
    const repo = makeRepo(root);
    const cmd = `echo "FAIL tests/golden.test.ts > dev"; if test -f feature.txt; then echo "FAIL tests/card.test.ts > new thing"; fi; false`;
    const cfg = makeConfig(root, repo, { maxRounds: 2, repos: { demo: { path: repo, testCmd: cmd } } });
    const out = await cook(cfg, { id: "abc123", title: "Add feature file", notes: [], repo: cfg.repos.demo! });
    expect(out.category).not.toBe("environment");
    const fix = fakeCalls().filter((c) => !c.prompt.includes("REVIEWER"))[1]!.prompt;
    expect(fix).toMatch(/already on main and are not yours/);
    expect(fix).toMatch(/Fix only these[^\n]*\n- FAIL tests\/card\.test\.ts > new thing/);
    expect(fix).not.toMatch(/- FAIL tests\/golden/);
  });

  it("compares failures without timings, hashes or the worktree path", () => {
    const a = "\x1b[31m FAIL \x1b[0m /w/t/packages/x tests/a.test.ts > slow (1532ms)\n@nex/x:test: [ELIFECYCLE] Test failed.\nok line";
    const b = " FAIL  /w/u/packages/x tests/a.test.ts > slow (12ms)\n@nex/y:test: [ELIFECYCLE] Test failed.";
    expect([...failureSignature(a, "/w/t")]).toEqual(["FAIL /packages/x tests/a.test.ts > slow (T)"]);
    expect(newFailures(a, b.replace("/w/u", "/w/t"), "/w/t")).toEqual([]);
    expect(newFailures(a + "\n FAIL tests/b.test.ts > other", b.replace("/w/u", "/w/t"), "/w/t")).toEqual(["FAIL tests/b.test.ts > other"]);
  });

  it("stops when the worker makes no new commits after checks failed", async () => {
    process.env.FAKE_WORKER = "editonce";
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = makeConfig(root, repo, { maxRounds: 3, repos: { demo: { path: repo, testCmd: "test ! -f feature.txt" } } });
    const out = await cook(cfg, { id: "abc123", title: "Add feature file", notes: [], repo: cfg.repos.demo! });
    expect(out.status).toBe("blocked");
    expect(out.reason).toMatch(/made no new commits/);
    expect(out.category).toBe("checks");
    expect(fakeCalls()).toHaveLength(2); // round 3 never runs
  });

  it("retries only the PR step when the approved commit is unchanged", async () => {
    const { cfg, input } = setup({ openPr: true });
    const first = await cook(cfg, input);
    expect(first.reason).toMatch(/PR step failed/);
    expect(first.approved?.head).toMatch(/^[0-9a-f]{40}$/);
    const calls = fakeCalls().length;

    const second = await cook(cfg, { ...input, previous: { reason: first.reason, approved: first.approved } });
    expect(fakeCalls()).toHaveLength(calls); // no worker, no reviewer
    expect(second.reason).toMatch(/PR step failed/);
    expect(second.approved?.head).toBe(first.approved!.head);
    expect(readFileSync(second.runLog!, "utf8")).toMatch(/skips straight to the PR/);
  });

  it("tells a retried worker why the last attempt stopped and what it already committed", async () => {
    const { cfg, input } = setup();
    await cook(cfg, input);
    await cook(cfg, { ...input, previous: { reason: "BLOCKED: which DB?" } });
    const prompt = fakeCalls().filter((c) => !c.prompt.includes("REVIEWER")).at(-1)!.prompt;
    expect(prompt).toContain("PREVIOUS ATTEMPT");
    expect(prompt).toContain("It stopped because: BLOCKED: which DB?");
    expect(prompt).toMatch(/already has these commits[\s\S]*- [0-9a-f]{7,}/);
  });

  it("reads every result when the worker answered twice (background command)", async () => {
    process.env.FAKE_SECOND_RESULT = "The background test run finished.";
    const { cfg, input } = setup();
    const out = await cook(cfg, input);
    expect(out.summary).toContain("Changed feature.txt");
    expect(out.summary).toContain("The background test run finished.");
    const log = readFileSync(out.runLog!, "utf8");
    expect(log).toMatch(/\*\*Worker\*\* · 1m 07s · 4 turns · \$0\.30/);
  });
});

describe("mergeResults", () => {
  it("prefers a BLOCKED answer, adds up time and turns, and keeps the cumulative cost", async () => {
    const { mergeResults } = await import("../src/claude.js");
    const m = mergeResults([
      { type: "result", result: "BLOCKED: need a key", duration_ms: 1000, num_turns: 5, total_cost_usd: 0.1, permission_denials: [{ tool_name: "Bash" }] },
      { type: "result", result: "background job done", duration_ms: 500, num_turns: 1, total_cost_usd: 0.12 },
    ])!;
    expect(m).toMatchObject({ result: "BLOCKED: need a key", duration_ms: 1500, num_turns: 6, total_cost_usd: 0.12 });
    expect(m.permission_denials).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("slugifies titles for branch names", () => {
    expect(slugify("Fix: date parsing in Report (EU)!")).toBe("fix-date-parsing-in-report-eu");
    expect(slugify("!!!")).toBe("task");
    expect(slugify("a".repeat(80))).toHaveLength(40);
  });

  it("parses fenced and bare review JSON, defaulting unknown fields safely", () => {
    expect(parseReview('```json\n{"verdict":"approve","blast":"red","findings":[]}\n```')).toMatchObject({ verdict: "approve", blast: "red" });
    expect(parseReview('Sure. {"verdict":"changes","findings":["a:1 - x"]}')).toMatchObject({ verdict: "changes", blast: "yellow", findings: ["a:1 - x"] });
    expect(parseReview("looks good to me").verdict).toBe("error");
  });

  it("builds claude args with variadic tool flags last and no prompt in argv", () => {
    const cfg = parseConfig({ boardPath: "/b.md", repos: { r: { path: "/r" } }, model: "opus", maxBudgetUsd: 2 });
    const { bin, args } = buildClaudeArgs(cfg, {
      cwd: "/r", prompt: "SECRET PROMPT", allowedTools: ["Read"], disallowedTools: ["WebFetch"],
      permissionMode: "dontAsk", resumeSessionId: "s1", timeoutMs: 1000,
    });
    expect(bin).toBe("claude");
    expect(args).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
      "--setting-sources", "", "--strict-mcp-config", "--model", "opus",
      "--resume", "s1", "--max-budget-usd", "2", "--allowedTools", "Read", "--disallowedTools", "WebFetch",
    ]);
    expect(args.join(" ")).not.toContain("SECRET");
  });

  it("only loads the setting sources and MCP servers the config asks for", () => {
    const cfg = parseConfig({ boardPath: "/b.md", repos: { r: { path: "/r" } }, settingSources: "project", strictMcpConfig: false });
    const { args } = buildClaudeArgs(cfg, { cwd: "/r", prompt: "x", allowedTools: [], disallowedTools: [], permissionMode: "dontAsk", timeoutMs: 1 });
    expect(args).toEqual(expect.arrayContaining(["--setting-sources", "project"]));
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("tells the worker which extra commands the repo allows", async () => {
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = makeConfig(root, repo, { repos: { demo: { path: repo, testCmd: "test -f feature.txt", allowedTools: ["Bash(pnpm turbo run test:*)", "Read"] } } });
    await cook(cfg, { id: "abc123", title: "Add feature file", notes: [], repo: cfg.repos.demo! });
    expect(fakeCalls()[0]!.prompt).toContain("Other commands you may run here: `pnpm turbo run test …`.");
  });

  it("adds repo check commands to the worker allowlist without duplicates", () => {
    const cfg = parseConfig({ boardPath: "/b.md", repos: { r: { path: "/r", testCmd: "npm test", allowedTools: ["Read"] } } });
    const tools = workerTools(cfg, cfg.repos.r!);
    expect(tools).toContain("Bash(npm test:*)");
    expect(tools.filter((t) => t === "Read")).toHaveLength(1);
  });
});
