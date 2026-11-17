import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Blast } from "./state.js";
import type { RunMetrics } from "./trace.js";

/** Why an attempt ended Blocked, coarse enough to count. */
export type BlockCategory = "question" | "checks" | "review" | "review-error" | "worker-error" | "commit" | "pr" | "chief-error" | "interrupted" | "other";

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
  | { kind: "served" | "abandoned"; at: string; id: string; repo: string };

export function categorize(reason = ""): BlockCategory {
  if (/^interrupted/i.test(reason)) return "interrupted";
  if (/^BLOCKED:/i.test(reason)) return "question";
  if (/^Chief error/i.test(reason)) return "chief-error";
  if (/^worker failed/i.test(reason)) return "worker-error";
  if (/PR step failed/i.test(reason)) return "pr";
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
}

export function computeStats(events: LedgerEvent[], opts: { repo?: string; since: Date }): Stats {
  const inScope = events.filter((e) => (!opts.repo || e.repo === opts.repo) && new Date(e.at) >= opts.since);
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
    row("cost", `$${s.costUsd.toFixed(2)}`, s.costReported < s.attempts ? `(reported on ${s.costReported} of ${s.attempts})` : ""),
  ].join("\n");
}
