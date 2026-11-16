import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createDraftPr, pushBranch } from "./ado.js";
import { callClaude } from "./claude.js";
import type { Config, RepoConfig } from "./config.js";
import { fixPrompt, reviewPrompt, workerPrompt, type Brief } from "./prompts.js";
import { git, sh, tail } from "./run.js";
import type { Blast } from "./state.js";
import { RunLog } from "./trace.js";

export type Log = (msg: string) => void;

export interface CookInput {
  id: string;
  title: string;
  notes: string[];
  repo: RepoConfig;
  /** Branch to start from and open the PR against; defaults to repo.defaultBranch. */
  base?: string;
}

/** The branch a card starts from and its PR targets. */
export function targetBranch(input: Pick<CookInput, "repo" | "base">): string {
  return input.base ?? input.repo.defaultBranch;
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
  /** Path of the Markdown run log for this attempt. */
  runLog?: string;
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
  const target = targetBranch(input);
  let baseRef = target;
  if (cfg.fetchBeforeBranch) {
    const fetched = await git(["fetch", "origin", target], repo.path);
    if (fetched.code === 0) baseRef = `origin/${target}`;
  }
  if ((await git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], repo.path)).code !== 0) {
    throw new Error(`base branch "${target}" was not found on origin or locally in ${repo.name}`);
  }
  if (!existsSync(worktree)) {
    mkdirSync(cfg.worktreesDir, { recursive: true });
    const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo.path)).code === 0;
    await mustGit(exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, baseRef], repo.path);
  }
  const base = await mustGit(["merge-base", "HEAD", baseRef], worktree);
  return { branch, worktree, base };
}

/**
 * Remove a finished card's worktree and its local chief/ branch. Only touches paths under
 * worktreesDir and branches named chief/..., so your own checkouts are never affected.
 * The merged work lives on in the target branch; the remote branch is ADO's to delete.
 */
export async function removeWorktree(cfg: Config, repo: RepoConfig, worktree?: string, branch?: string): Promise<string[]> {
  const removed: string[] = [];
  const root = resolve(cfg.worktreesDir) + sep;
  if (worktree && resolve(worktree).startsWith(root)) {
    if (existsSync(worktree)) {
      const r = await git(["worktree", "remove", "--force", worktree], repo.path);
      if (r.code !== 0) throw new Error(`git worktree remove failed: ${tail(r.stderr || r.stdout, 300)}`);
      removed.push(worktree);
    }
    await git(["worktree", "prune"], repo.path);
  }
  if (branch?.startsWith("chief/")) {
    const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo.path)).code === 0;
    if (exists) {
      const r = await git(["branch", "-D", branch], repo.path);
      if (r.code !== 0) throw new Error(`git branch -D failed: ${tail(r.stderr || r.stdout, 300)}`);
      removed.push(branch);
    }
  }
  return removed;
}

/**
 * Safety net for work the worker left uncommitted. Returns the hook output if the
 * repo's commit hooks (commitlint etc.) reject Chief's generic message, so the
 * worker can commit with a message in the repo's own convention instead.
 */
async function commitLeftovers(worktree: string, title: string): Promise<string | undefined> {
  const status = await mustGit(["status", "--porcelain"], worktree);
  if (!status) return undefined;
  await mustGit(["add", "-A"], worktree);
  const r = await git(["commit", "-m", `chief: ${title}`], worktree);
  return r.code === 0 ? undefined : tail(`${r.stdout}\n${r.stderr}`.trim(), 1500);
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

async function review(cfg: Config, input: CookInput, worktree: string, base: string, runLog: RunLog, round: number): Promise<Review> {
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
    traceFile: runLog.traceFile(round, "reviewer"),
  });
  runLog.addAgent("reviewer", round, runLog.traceFile(round, "reviewer"), res.denials, res.ok ? undefined : res.error);
  const rev: Review = res.ok
    ? parseReview(res.text)
    : { verdict: "error", blast: "yellow", findings: [], error: `reviewer failed: ${res.error}` };
  runLog.add({ kind: "review", round, verdict: rev.error ? `error: ${rev.error}` : rev.verdict, blast: rev.blast, findings: rev.findings });
  return rev;
}

function prDescription(input: CookInput, summary: string, checks: string, rev: Review, rounds: number, activity: string): string {
  return [
    `Automated by Chief (card \`#chief-${input.id}\`, ${rounds} round${rounds === 1 ? "" : "s"}).`,
    ...(input.base ? ["", `Stacked on \`${input.base}\`: this PR targets that branch, so it shows only this card's changes. Once that branch merges, retarget this PR to \`${input.repo.defaultBranch}\`.`] : []),
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
    "## Agent activity",
    activity,
    "",
    "## How to revert",
    "Revert the merge commit of this PR (or abandon the PR and delete the branch).",
  ].join("\n");
}

/** Brief → worker → proof → review loop (max rounds) → draft PR. Never merges. */
export async function cook(cfg: Config, input: CookInput, log: Log = () => {}): Promise<Outcome> {
  const { branch, worktree, base } = await prepareWorktree(cfg, input);
  const brief: Brief = { title: input.title, notes: input.notes, repo: input.repo };
  const runLog = new RunLog(cfg, { id: input.id, title: input.title, repo: input.repo.name }, branch);
  runLog.write();
  const blocked = (reason: string, rounds: number, summary = ""): Outcome => {
    runLog.add({ kind: "outcome", status: "blocked", text: `Blocked after round ${rounds}: ${reason}` });
    return { status: "blocked", reason, summary, rounds, branch, worktree, runLog: runLog.path };
  };

  try {
    return await runRounds();
  } catch (err) {
    runLog.add({ kind: "outcome", status: "blocked", text: `Chief error: ${(err as Error).message}` });
    throw err;
  }

  async function runRounds(): Promise<Outcome> {
    let sessionId: string | undefined;
    let feedback: string | undefined;
    let summary = "";
    let checks = "";
    let approved: Review | undefined;
    let rounds = 0;

    for (rounds = 1; rounds <= cfg.maxRounds; rounds++) {
      log(`[${input.id}] round ${rounds}: worker`);
      const resume = rounds > 1 && sessionId !== undefined;
      const trace = runLog.traceFile(rounds, "worker");
      let res = await callClaude(cfg, {
        cwd: worktree,
        prompt: resume ? fixPrompt(feedback ?? "") : workerPrompt(brief, feedback),
        allowedTools: workerTools(cfg, input.repo),
        disallowedTools: cfg.disallowedTools,
        permissionMode: cfg.workerPermissionMode,
        resumeSessionId: resume ? sessionId : undefined,
        timeoutMs: cfg.workerTimeoutMinutes * 60_000,
        traceFile: trace,
      });
      if (!res.ok && resume) {
        log(`[${input.id}] resume failed (${res.error}); retrying with a fresh session`);
        runLog.add({ kind: "note", round: rounds, text: `Resuming the worker session failed (${res.error}); retried with a fresh session.` });
        res = await callClaude(cfg, {
          cwd: worktree,
          prompt: workerPrompt(brief, feedback),
          allowedTools: workerTools(cfg, input.repo),
          disallowedTools: cfg.disallowedTools,
          permissionMode: cfg.workerPermissionMode,
          timeoutMs: cfg.workerTimeoutMinutes * 60_000,
          traceFile: trace,
        });
      }
      runLog.addAgent("worker", rounds, trace, res.denials, res.ok ? undefined : res.error);
      const denied = res.denials.length ? ` (denied: ${[...new Set(res.denials)].join("; ")})` : "";
      if (res.denials.length) log(`[${input.id}] permission denials: ${res.denials.join("; ")}`);
      if (!res.ok) return blocked(`worker failed: ${res.error}${denied}`, rounds, summary);
      sessionId = res.sessionId ?? sessionId;
      summary = res.text;
      if (/^\s*BLOCKED:/i.test(res.text)) return blocked(res.text.trim().split("\n")[0]! + denied, rounds, summary);

      const commitError = await commitLeftovers(worktree, input.title);
      if (commitError) {
        runLog.add({ kind: "note", round: rounds, text: `Chief's fallback commit was rejected by the repo's commit hooks; sent back to the worker. ${commitError}` });
        feedback = `Your changes are not committed: Chief's fallback commit was rejected by this repo's commit hooks:\n${commitError}\n\nCommit them yourself (git add, git commit) with a message in this repo's convention, then finish.`;
        continue;
      }
      if ((await commitCount(worktree, base)) === 0) {
        feedback = "No changes were committed. Implement the card, then git add and git commit.";
        runLog.add({ kind: "note", round: rounds, text: "The worker committed nothing; asked again." });
        continue;
      }

      log(`[${input.id}] round ${rounds}: checks`);
      const result = await runChecks(cfg, input.repo, worktree);
      checks = result.report;
      runLog.add({ kind: "checks", round: rounds, ok: result.ok, report: result.report });
      if (!result.ok) {
        feedback = `Checks failed:\n${result.report}`;
        continue;
      }

      log(`[${input.id}] round ${rounds}: review`);
      const rev = await review(cfg, input, worktree, base, runLog, rounds);
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
      status: "pass", summary, blast: approved.blast, findings: approved.findings, rounds, branch, worktree, runLog: runLog.path,
    };
    if (!cfg.openPr) {
      runLog.add({ kind: "outcome", status: "pass", text: `Approved in ${rounds} round(s); work is on branch \`${branch}\` (openPr is off).` });
      return outcome;
    }

    log(`[${input.id}] opening draft PR`);
    try {
      await pushBranch(worktree, branch);
      const pr = await createDraftPr(cfg, input.repo, worktree, branch, targetBranch(input), input.title, prDescription(input, summary, checks, approved, rounds, runLog.activity()));
      runLog.add({ kind: "outcome", status: "pass", text: `Draft PR [!${pr.id}](${pr.url}) opened after ${rounds} round(s).` });
      return { ...outcome, prId: pr.id, prUrl: pr.url };
    } catch (err) {
      return blocked(`work is ready on branch ${branch} but the PR step failed: ${(err as Error).message}`, rounds, summary);
    }
  }
}
