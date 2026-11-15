import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDraftPr, pushBranch } from "./ado.js";
import { callClaude } from "./claude.js";
import type { Config, RepoConfig } from "./config.js";
import { fixPrompt, reviewPrompt, workerPrompt, type Brief } from "./prompts.js";
import { git, sh, tail } from "./run.js";
import type { Blast } from "./state.js";

export type Log = (msg: string) => void;

export interface CookInput {
  id: string;
  title: string;
  notes: string[];
  repo: RepoConfig;
}

export interface Outcome {
  status: "pass" | "blocked";
  reason?: string;
  summary: string;
  blast?: Blast;
  findings?: string[];
  prId?: number;
  prUrl?: string;
  rounds: number;
  branch: string;
  worktree: string;
}

export interface Review {
  verdict: "approve" | "changes" | "error";
  blast: Blast;
  findings: string[];
  error?: string;
}

const MAX_DIFF_CHARS = 80_000;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "task";
}

export function workerTools(cfg: Config, repo: RepoConfig): string[] {
  const checks = [repo.testCmd, repo.lintCmd].filter(Boolean).map((c) => `Bash(${c}:*)`);
  return [...new Set([...cfg.allowedTools, ...repo.allowedTools, ...checks])];
}

export function parseReview(text: string): Review {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const data = JSON.parse(candidate) as { verdict?: string; blast?: string; findings?: unknown };
    const verdict = data.verdict?.toLowerCase() === "approve" ? "approve" : "changes";
    const blast = (["green", "yellow", "red"] as const).find((b) => b === data.blast?.toLowerCase()) ?? "yellow";
    const findings = Array.isArray(data.findings) ? data.findings.map(String) : [];
    return { verdict, blast, findings };
  } catch {
    return { verdict: "error", blast: "yellow", findings: [], error: `unparseable review: ${tail(text, 300)}` };
  }
}

async function mustGit(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${tail(r.stderr, 500)}`);
  return r.stdout.trim();
}

async function prepareWorktree(cfg: Config, input: CookInput): Promise<{ branch: string; worktree: string; base: string }> {
  const { repo, id, title } = input;
  const branch = `chief/${id}-${slugify(title)}`;
  const worktree = join(cfg.worktreesDir, `${repo.name}-${id}`);
  let baseRef = repo.defaultBranch;
  if (cfg.fetchBeforeBranch) {
    const fetched = await git(["fetch", "origin", repo.defaultBranch], repo.path);
    if (fetched.code === 0) baseRef = `origin/${repo.defaultBranch}`;
  }
  if (!existsSync(worktree)) {
    mkdirSync(cfg.worktreesDir, { recursive: true });
    const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo.path)).code === 0;
    await mustGit(exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, baseRef], repo.path);
  }
  const base = await mustGit(["merge-base", "HEAD", baseRef], worktree);
  return { branch, worktree, base };
}

async function commitLeftovers(worktree: string, title: string): Promise<void> {
  const status = await mustGit(["status", "--porcelain"], worktree);
  if (!status) return;
  await mustGit(["add", "-A"], worktree);
  await mustGit(["commit", "-m", `chief: ${title}`], worktree);
}

async function commitCount(worktree: string, base: string): Promise<number> {
  return Number(await mustGit(["rev-list", "--count", `${base}..HEAD`], worktree));
}

async function runChecks(cfg: Config, repo: RepoConfig, worktree: string): Promise<{ ok: boolean; report: string }> {
  const lines: string[] = [];
  let ok = true;
  for (const [name, cmd] of [["test", repo.testCmd], ["lint", repo.lintCmd]] as const) {
    if (!cmd) continue;
    const r = await sh(cmd, worktree, cfg.checkTimeoutMinutes * 60_000);
    const passed = r.code === 0 && !r.timedOut;
    ok &&= passed;
    lines.push(`${passed ? "✓" : "✗"} ${name}: \`${cmd}\`${r.timedOut ? " (timed out)" : ` (exit ${r.code})`}`);
    if (!passed) lines.push("```", tail(`${r.stdout}\n${r.stderr}`.trim(), 3000), "```");
  }
  return { ok, report: lines.join("\n") || "no checks configured" };
}

async function review(cfg: Config, input: CookInput, worktree: string, base: string): Promise<Review> {
  let diff = await mustGit(["diff", base, "HEAD"], worktree);
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n… (diff truncated; read the files directly)";
  const reviewPath = join(worktree, "REVIEW.md");
  const reviewMd = existsSync(reviewPath) ? readFileSync(reviewPath, "utf8") : undefined;
  const res = await callClaude(cfg, {
    cwd: worktree,
    prompt: reviewPrompt(input.title, diff, reviewMd),
    allowedTools: cfg.reviewAllowedTools,
    disallowedTools: [...new Set([...cfg.disallowedTools, "Edit", "Write"])],
    permissionMode: cfg.reviewPermissionMode,
    timeoutMs: cfg.workerTimeoutMinutes * 60_000,
  });
  if (!res.ok) return { verdict: "error", blast: "yellow", findings: [], error: `reviewer failed: ${res.error}` };
  return parseReview(res.text);
}

function prDescription(input: CookInput, summary: string, checks: string, rev: Review, rounds: number): string {
  return [
    `Automated by Chief (card \`#chief-${input.id}\`, ${rounds} round${rounds === 1 ? "" : "s"}).`,
    "",
    "## Summary",
    summary.trim() || "(no summary)",
    "",
    "## Testing",
    checks,
    "",
    "## Risk",
    `Blast radius: **${rev.blast}**`,
    ...(rev.findings.length ? ["", "Reviewer notes:", ...rev.findings.map((f) => `- ${f}`)] : []),
    "",
    "## How to revert",
    "Revert the merge commit of this PR (or abandon the PR and delete the branch).",
  ].join("\n");
}

/** Brief → worker → proof → review loop (max rounds) → draft PR. Never merges. */
export async function cook(cfg: Config, input: CookInput, log: Log = () => {}): Promise<Outcome> {
  const { branch, worktree, base } = await prepareWorktree(cfg, input);
  const brief: Brief = { title: input.title, notes: input.notes, repo: input.repo };
  const blocked = (reason: string, rounds: number, summary = ""): Outcome => ({
    status: "blocked", reason, summary, rounds, branch, worktree,
  });

  let sessionId: string | undefined;
  let feedback: string | undefined;
  let summary = "";
  let checks = "";
  let approved: Review | undefined;
  let rounds = 0;

  for (rounds = 1; rounds <= cfg.maxRounds; rounds++) {
    log(`[${input.id}] round ${rounds}: worker`);
    const resume = rounds > 1 && sessionId !== undefined;
    let res = await callClaude(cfg, {
      cwd: worktree,
      prompt: resume ? fixPrompt(feedback ?? "") : workerPrompt(brief, feedback),
      allowedTools: workerTools(cfg, input.repo),
      disallowedTools: cfg.disallowedTools,
      permissionMode: cfg.workerPermissionMode,
      resumeSessionId: resume ? sessionId : undefined,
      timeoutMs: cfg.workerTimeoutMinutes * 60_000,
    });
    if (!res.ok && resume) {
      log(`[${input.id}] resume failed (${res.error}); retrying with a fresh session`);
      res = await callClaude(cfg, {
        cwd: worktree,
        prompt: workerPrompt(brief, feedback),
        allowedTools: workerTools(cfg, input.repo),
        disallowedTools: cfg.disallowedTools,
        permissionMode: cfg.workerPermissionMode,
        timeoutMs: cfg.workerTimeoutMinutes * 60_000,
      });
    }
    const denied = res.denials.length ? ` (denied: ${[...new Set(res.denials)].join("; ")})` : "";
    if (res.denials.length) log(`[${input.id}] permission denials: ${res.denials.join("; ")}`);
    if (!res.ok) return blocked(`worker failed: ${res.error}${denied}`, rounds, summary);
    sessionId = res.sessionId ?? sessionId;
    summary = res.text;
    if (/^\s*BLOCKED:/i.test(res.text)) return blocked(res.text.trim().split("\n")[0]! + denied, rounds, summary);

    await commitLeftovers(worktree, input.title);
    if ((await commitCount(worktree, base)) === 0) {
      feedback = "No changes were committed. Implement the card, then git add and git commit.";
      continue;
    }

    log(`[${input.id}] round ${rounds}: checks`);
    const result = await runChecks(cfg, input.repo, worktree);
    checks = result.report;
    if (!result.ok) {
      feedback = `Checks failed:\n${result.report}`;
      continue;
    }

    log(`[${input.id}] round ${rounds}: review`);
    const rev = await review(cfg, input, worktree, base);
    if (rev.verdict === "error") return blocked(rev.error ?? "review failed", rounds, summary);
    if (rev.verdict === "approve") {
      approved = rev;
      break;
    }
    feedback = `Reviewer requested changes:\n${rev.findings.map((f) => `- ${f}`).join("\n") || "- (no specifics given)"}`;
  }

  if (!approved) {
    const last = Math.min(rounds, cfg.maxRounds);
    return blocked(`did not converge after ${cfg.maxRounds} rounds; last feedback: ${tail(feedback ?? "", 400)}`, last, summary);
  }

  const outcome: Outcome = {
    status: "pass", summary, blast: approved.blast, findings: approved.findings, rounds, branch, worktree,
  };
  if (!cfg.openPr) return outcome;

  log(`[${input.id}] opening draft PR`);
  try {
    await pushBranch(worktree, branch);
    const pr = await createDraftPr(cfg, input.repo, worktree, branch, input.title, prDescription(input, summary, checks, approved, rounds));
    return { ...outcome, prId: pr.id, prUrl: pr.url };
  } catch (err) {
    return blocked(`work is ready on branch ${branch} but the PR step failed: ${(err as Error).message}`, rounds, summary);
  }
}
