#!/usr/bin/env node
// Stand-in for `claude -p` in tests. Behaviour is driven by env vars:
//   FAKE_STATE   dir for counters + a calls.jsonl log of argv/cwd/prompt
//   FAKE_WORKER  "edit" (default) | "blocked" | "nochange" | "fail" | "conventional"
//                ("conventional" commits as feat(demo): ... once told a hook rejected Chief's commit)
//   FAKE_DENY    a shell command to report as permission-denied
//   FAKE_REVIEW  comma list of verdicts per review call, e.g. "changes,approve"
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = readFileSync(0, "utf8");
const state = process.env.FAKE_STATE;
const args = process.argv.slice(2);
if (state) appendFileSync(join(state, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), prompt }) + "\n");

function counter(name) {
  if (!state) return 0;
  const file = join(state, name);
  const n = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  writeFileSync(file, String(n + 1));
  return n;
}

function out(result, isError = false) {
  const permission_denials = process.env.FAKE_DENY
    ? [{ tool_name: "Bash", tool_use_id: "t1", tool_input: { command: process.env.FAKE_DENY } }]
    : [];
  process.stdout.write(JSON.stringify({ type: "result", result, is_error: isError, session_id: "fake-session", total_cost_usd: 0, permission_denials }));
  process.exit(isError ? 1 : 0);
}

if (prompt.includes("REVIEWER AT THE PASS")) {
  const verdicts = (process.env.FAKE_REVIEW ?? "approve").split(",");
  const n = counter("reviews");
  const verdict = verdicts[Math.min(n, verdicts.length - 1)];
  out("```json\n" + JSON.stringify({ verdict, blast: "green", findings: verdict === "approve" ? [] : ["feature.txt:1 - needs more"] }) + "\n```");
}

const mode = process.env.FAKE_WORKER ?? "edit";
if (mode === "fail") out("boom", true);
if (mode === "blocked") out("BLOCKED: which environment should this target?\nmore detail");
if (mode !== "nochange") {
  const n = counter("edits");
  appendFileSync(join(process.cwd(), "feature.txt"), `edit ${n}\n`);
}
if (mode === "conventional" && prompt.includes("rejected by this repo's commit hooks")) {
  execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
  execFileSync("git", ["commit", "-q", "-m", "feat(demo): add feature file"], { cwd: process.cwd() });
}
out("Changed feature.txt. Acceptance test: test -f feature.txt. Revert: git revert.");
