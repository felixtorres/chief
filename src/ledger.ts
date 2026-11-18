import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Blast } from "./state.js";
import type { RunMetrics } from "./trace.js";

/** Why an attempt ended Blocked, coarse enough to count. */
export type BlockCategory = "question" | "checks" | "review" | "review-error" | "worker-error" | "commit" | "pr" | "chief-error" | "interrupted" | "environment" | "other";

export type LedgerEvent =
  | ({
      kind: "run";
      at: string;
      id: string;
      repo: string;
      status: "pass" | "blocked";
      rounds: number;
      blast?: Blast;
      category?: BlockCategory;
      ruleFiles?: string[];
    } & Partial<RunMetrics>)
  | { kind: "served" | "abandoned"; at: string; id: string; repo: string }
  | { kind: "reflect"; at: string; id: string; repo: string; proposals: number; dropped: number; error?: string; signal?: string }
  | { kind: "corrected"; at: string; id: string; repo: string; files: number; insertions: number; deletions: number }
  | { kind: "reverted"; at: string; id: string; repo: string; sha: string }
  | { kind: "triage"; at: string; repo?: undefined; cards: number; scored: number; costUsd?: number; error?: string };

export function categorize(reason = ""): BlockCategory {
  if (/^interrupted/i.test(reason)) return "interrupted";
  if (/^BLOCKED:/i.test(reason)) return "question";
  if (/^Chief error/i.test(reason)) return "chief-error";
  if (/^worker failed/i.test(reason)) return "worker-error";
  if (/PR step failed/i.test(reason)) return "pr";
  if (/without this card's changes/i.test(reason)) return "environment";
  if (/^(reviewer failed|unparseable review|review failed)/i.test(reason)) return "review-error";
  if (/did not converge/i.test(reason)) {
    if (/Checks failed/i.test(reason)) return "checks";
    if (/Reviewer requested changes/i.test(reason)) return "review";
    if (/not committed|No changes were committed/i.test(reason)) return "commit";
  }
  return "other";
}

/** Append one event. The ledger is for metrics; a failed write never breaks a run. */
export function appendLedger(file: string, event: LedgerEvent): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(event) + "\n");
  } catch {
    // metrics only
  }
}

export function readLedger(file: string): LedgerEvent[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: LedgerEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      // skip a torn line
    }
  }
  return events;
}

export interface Stats {
  repo?: string;
  since: Date;
  attempts: number;
  cards: number;
  passed: number;
  firstPass: number;
  meanRounds: number;
  blocked: number;
  blockedBy: Partial<Record<BlockCategory, number>>;
  withDenials: number;
  ruleFileEdits: number;
  served: number;
  abandoned: number;
  costUsd: number;
  costReported: number;
  /** Served PRs you changed before merging. */
  corrected: number;
  reverted: number;
  recipesProposed: number;
}

export function computeStats(events: LedgerEvent[], opts: { repo?: string; since: Date; until?: Date }): Stats {
  const inScope = events.filter((e) => {
    const t = new Date(e.at);
    return (!opts.repo || e.repo === opts.repo) && t >= opts.since && (!opts.until || t < opts.until);
  });
  const runs = inScope.filter((e): e is Extract<LedgerEvent, { kind: "run" }> => e.kind === "run");
  const s: Stats = {
    repo: opts.repo,
    since: opts.since,
    attempts: runs.length,
    cards: new Set(runs.map((r) => r.id)).size,
    passed: 0,
    firstPass: 0,
    meanRounds: 0,
    blocked: 0,
    blockedBy: {},
    withDenials: 0,
    ruleFileEdits: 0,
    served: inScope.filter((e) => e.kind === "served").length,
    abandoned: inScope.filter((e) => e.kind === "abandoned").length,
    costUsd: 0,
    costReported: 0,
    corrected: inScope.filter((e) => e.kind === "corrected").length,
    reverted: inScope.filter((e) => e.kind === "reverted").length,
    recipesProposed: inScope.reduce((n, e) => n + (e.kind === "reflect" ? e.proposals : 0), 0),
  };
  let roundSum = 0;
  let roundRuns = 0;
  for (const r of runs) {
    if (r.status === "pass") {
      s.passed++;
      if (r.rounds === 1) s.firstPass++;
    } else {
      s.blocked++;
      const c = r.category ?? "other";
      s.blockedBy[c] = (s.blockedBy[c] ?? 0) + 1;
    }
    if (r.rounds > 0) {
      roundSum += r.rounds;
      roundRuns++;
    }
    if (r.denials) s.withDenials++;
    if (r.ruleFiles?.length) s.ruleFileEdits++;
    if (r.costUsd !== undefined) {
      s.costUsd += r.costUsd;
      s.costReported++;
    }
  }
  s.meanRounds = roundRuns ? roundSum / roundRuns : 0;
  return s;
}

function pct(n: number, of: number): string {
  return of ? `${Math.round((100 * n) / of)}%` : "–";
}

export function formatStats(s: Stats, weeks: number): string {
  const scope = s.repo ? `repo ${s.repo}` : "all repos";
  if (!s.attempts && !s.served && !s.abandoned) return `Chief stats · last ${weeks} week${weeks === 1 ? "" : "s"} · ${scope}\n  no runs yet`;
  const row = (label: string, value: string | number, extra = ""): string => `  ${label.padEnd(20)} ${String(value).padEnd(7)} ${extra}`.trimEnd();
  const reasons = Object.entries(s.blockedBy)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  return [
    `Chief stats · last ${weeks} week${weeks === 1 ? "" : "s"} · ${scope}`,
    row("attempts", s.attempts, `(${s.cards} card${s.cards === 1 ? "" : "s"})`),
    row("passed", s.passed, pct(s.passed, s.attempts)),
    row("first-pass", s.firstPass, `${pct(s.firstPass, s.attempts)}  (passed in 1 round)`),
    row("mean rounds", s.meanRounds.toFixed(1)),
    row("blocked", s.blocked, `${pct(s.blocked, s.attempts)}${reasons ? `  ${reasons}` : ""}`),
    row("with denials", s.withDenials),
    row("rule-file edits", s.ruleFileEdits),
    row("served / abandoned", `${s.served} / ${s.abandoned}`),
    row("corrected by you", s.corrected, s.served ? `${pct(s.corrected, s.served)} of served` : ""),
    row("reverted", s.reverted),
    row("recipes proposed", s.recipesProposed),
    row("cost", `$${s.costUsd.toFixed(2)}`, s.costReported < s.attempts ? `(reported on ${s.costReported} of ${s.attempts})` : ""),
  ].join("\n");
}

export const WEEKLY_MARKER = "<!-- chief:weekly-stats -->";
const DAY_MS = 24 * 3600_000;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function statsRow(name: string, s: Stats): string {
  const reasons = Object.entries(s.blockedBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  return `| ${name} | ${s.attempts} | ${pct(s.passed, s.attempts)} | ${pct(s.firstPass, s.attempts)} | ${s.meanRounds.toFixed(1)} | ${s.blocked}${reasons ? ` (${reasons})` : ""} | ${s.served} / ${s.abandoned} | $${s.costUsd.toFixed(2)} |`;
}

/**
 * Markdown block for the digest: the 7 full days before `now` (local midnight to midnight),
 * one row per repo plus a total, and the first-pass rate against the week before.
 * Undefined when nothing happened that week.
 */
export function weeklyStatsBlock(events: LedgerEvent[], repos: string[], now = new Date()): string | undefined {
  const until = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const since = new Date(until.getTime() - 7 * DAY_MS);
  const prevSince = new Date(since.getTime() - 7 * DAY_MS);
  const total = computeStats(events, { since, until });
  if (!total.attempts && !total.served && !total.abandoned && !total.reverted) return undefined;
  const prev = computeStats(events, { since: prevSince, until: since });

  const lastDay = new Date(until.getTime() - DAY_MS);
  const lines = [
    "",
    WEEKLY_MARKER,
    `## 📊 Weekly stats · ${ymd(since)} → ${ymd(lastDay)}`,
    "",
    "| repo | attempts | passed | first-pass | mean rounds | blocked | served / abandoned | cost |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const active = repos
    .map((r) => [r, computeStats(events, { repo: r, since, until })] as const)
    .filter(([, st]) => st.attempts || st.served || st.abandoned);
  for (const [name, st] of active) lines.push(statsRow(name, st));
  if (active.length !== 1) lines.push(statsRow("**all**", total));

  const notes: string[] = [];
  if (prev.attempts) {
    notes.push(`First-pass ${pct(total.firstPass, total.attempts)} vs ${pct(prev.firstPass, prev.attempts)} the week before; mean rounds ${total.meanRounds.toFixed(1)} vs ${prev.meanRounds.toFixed(1)}.`);
  } else {
    notes.push("No runs the week before to compare with.");
  }
  if (total.withDenials) notes.push(`${total.withDenials} attempt(s) hit allowlist denials.`);
  if (total.ruleFileEdits) notes.push(`${total.ruleFileEdits} attempt(s) edited agent rule files (🔴).`);
  if (total.served) notes.push(`You corrected ${total.corrected} of ${total.served} served PR(s) before merging.`);
  if (total.reverted) notes.push(`${total.reverted} merged PR(s) were reverted.`);
  if (total.recipesProposed) notes.push(`${total.recipesProposed} recipe(s) proposed: see the Recipes lane.`);
  if (total.costReported < total.attempts) notes.push(`Cost reported on ${total.costReported} of ${total.attempts} attempts.`);
  lines.push("", ...notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

/** Reflector calls made on the same local day as `now` (for the daily cap). */
export function reflectionsOn(events: LedgerEvent[], now = new Date()): number {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return events.filter((e) => {
    if (e.kind !== "reflect") return false;
    const t = new Date(e.at);
    return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() === day;
  }).length;
}
