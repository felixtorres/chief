import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callClaude } from "./claude.js";
import type { Config, RepoConfig } from "./config.js";
import { workerTools, type Outcome } from "./pipeline.js";
import { reflectPrompt } from "./prompts.js";
import { KIND_LABEL, parseProposals, recipesSection, type Proposal, type Recipe } from "./recipes.js";
import { git } from "./run.js";

const MAX_LOG_CHARS = 40_000;
const MAX_RULE_CHARS = 8_000;

/** Blocked reasons that say nothing about how the worker works: infrastructure, not recipes. */
const NOT_LEARNABLE = new Set(["chief-error", "interrupted", "pr"]);

/**
 * Worth a reflector call: the card got blocked for a work reason, needed more than one round,
 * hit allowlist denials, or edited rule files. A clean one-round pass costs nothing extra.
 */
export function isInteresting(o: Outcome): boolean {
  if (!o.runLog) return false;
  if (o.status === "blocked") return !NOT_LEARNABLE.has(o.category ?? "other");
  return o.rounds > 1 || (o.metrics?.denials ?? 0) > 0 || (o.ruleFiles?.length ?? 0) > 0;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n… (truncated)" : text;
}

/** A file as it is on the repo's default branch (origin first), never a worker's worktree. */
export async function fromTarget(repo: RepoConfig, file: string): Promise<string> {
  for (const ref of [`origin/${repo.defaultBranch}`, repo.defaultBranch]) {
    const r = await git(["show", `${ref}:${file}`], repo.path);
    if (r.code === 0) return r.stdout;
  }
  return "";
}

function describe(o: Outcome): string {
  const parts = [`${o.status === "pass" ? "passed" : "blocked"} after ${o.rounds} round${o.rounds === 1 ? "" : "s"}`];
  if (o.category && o.status === "blocked") parts.push(`category ${o.category}`);
  if (o.reason) parts.push(`reason: ${o.reason.slice(0, 600)}`);
  if (o.metrics?.denials) parts.push(`${o.metrics.denials} allowlist denial(s)`);
  if (o.ruleFiles?.length) parts.push(`edited rule files: ${o.ruleFiles.join(", ")}`);
  return parts.join("; ");
}

export interface Reflection {
  proposals: Proposal[];
  dropped: string[];
  error?: string;
  /** Rules under "## Chief recipes" per rule file on the target branch. */
  ruleCounts?: Record<string, number>;
}

export function countRules(content: string): number {
  return recipesSection(content).split("\n").filter((l) => /^- \S/.test(l)).length;
}

/** Read-only claude -p over the card's run log; returns vetted proposals (not yet stored). */
export async function reflect(
  cfg: Config,
  card: { id: string; title: string; repo: RepoConfig },
  outcome: Outcome,
  known: Recipe[],
  signal?: string,
): Promise<Reflection> {
  let runLog: string;
  try {
    runLog = readFileSync(outcome.runLog!, "utf8");
  } catch (err) {
    return { proposals: [], dropped: [], error: `run log unreadable: ${(err as Error).message}` };
  }
  const review = await fromTarget(card.repo, "REVIEW.md");
  const claude = await fromTarget(card.repo, "CLAUDE.md");
  const ruleCounts = { "REVIEW.md": countRules(review), "CLAUDE.md": countRules(claude) };
  const overBudget = Object.entries(ruleCounts)
    .filter(([, n]) => n >= cfg.recipeBudget)
    .map(([f, n]) => `${f} already has ${n} Chief recipes (budget ${cfg.recipeBudget})`);
  const prompt = reflectPrompt({
    cardId: card.id,
    title: card.title,
    repo: card.repo.name,
    outcome: describe(outcome),
    runLog: clip(runLog, MAX_LOG_CHARS),
    reviewRules: clip(review, MAX_RULE_CHARS),
    claudeRules: clip(claude, MAX_RULE_CHARS),
    allowedTools: workerTools(cfg, card.repo),
    known: known.map((r) => `- [${r.status}] ${r.dedupeKey}: ${KIND_LABEL[r.kind]}: ${r.text}`),
    signal,
    overBudget,
  });
  const cwd = outcome.worktree && existsSync(outcome.worktree) ? outcome.worktree : card.repo.path;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const res = await callClaude(cfg, {
    cwd,
    prompt,
    allowedTools: cfg.reviewAllowedTools,
    disallowedTools: [...new Set([...cfg.disallowedTools, "Edit", "Write", "NotebookEdit"])],
    permissionMode: cfg.reviewPermissionMode,
    timeoutMs: cfg.workerTimeoutMinutes * 60_000,
    traceFile: join(cfg.tracesDir, card.id, `${stamp}-reflector.jsonl`),
  });
  if (!res.ok) return { proposals: [], dropped: [], error: `reflector failed: ${res.error}`, ruleCounts };
  return { ...parseProposals(res.text, cfg.disallowedTools), ruleCounts };
}
