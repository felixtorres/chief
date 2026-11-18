import { callClaude } from "./claude.js";
import type { Config } from "./config.js";
import { triagePrompt, type TriageCard } from "./prompts.js";
import { fromTarget } from "./reflect.js";
import type { Blast } from "./state.js";

/** Chief's status on a triaged Backlog card starts with this. */
export const TRIAGE_ICON = "📊";
/** Cards per triage call: one cheap call for a batch, not one per card. */
export const TRIAGE_BATCH = 10;
const REPO_NOTES_CHARS = 1_500;

const IMPACTS = [0.25, 0.5, 1, 2, 3];
const CONFIDENCES = [0.5, 0.8, 1];
const BLASTS: Blast[] = ["green", "yellow", "red"];
const BLAST_ICON: Record<Blast, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

export interface TriageScore {
  reach: number;
  impact: number;
  confidence: number;
  /** Working days for one engineer. */
  effort: number;
  blast: Blast;
  /** Suggested repo for a card without a #repo tag. */
  repo?: string;
  why: string;
}

/** RICE = reach × impact × confidence ÷ effort. */
export function rice(s: Pick<TriageScore, "reach" | "impact" | "confidence" | "effort">): number {
  return (s.reach * s.impact * s.confidence) / s.effort;
}

function fmt(n: number): string {
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** One line for the card: score first, so the Backlog reads like a ranked list. */
export function triageStatus(s: TriageScore): string {
  const parts = [
    `${TRIAGE_ICON} RICE ${fmt(rice(s))}`,
    `R${s.reach} I${s.impact} C${Math.round(s.confidence * 100)}% E${Math.round(s.effort * 100) / 100}d`,
    `${BLAST_ICON[s.blast]} ${s.blast}`,
  ];
  if (s.repo) parts.push(`suggest repo ${s.repo}`);
  const why = s.why.replace(/\s+/g, " ").trim();
  if (why) parts.push(why.length > 120 ? why.slice(0, 119) + "…" : why);
  return parts.join(" · ");
}

function closest(v: number, allowed: number[]): number | undefined {
  return allowed.find((a) => Math.abs(a - v) < 1e-9);
}

/** Validate one scored card; a string is the reason it was dropped. */
export function vetScore(raw: unknown, repos: string[]): TriageScore | string {
  if (!raw || typeof raw !== "object") return "not an object";
  const r = raw as Record<string, unknown>;
  const reach = Number(r.reach);
  if (!Number.isInteger(reach) || reach < 1 || reach > 10) return `reach ${String(r.reach)} is not 1–10`;
  const impact = closest(Number(r.impact), IMPACTS);
  if (impact === undefined) return `impact ${String(r.impact)} is not one of ${IMPACTS.join("/")}`;
  // Accept 80 as well as 0.8.
  let conf = Number(r.confidence);
  if (conf > 1) conf /= 100;
  const confidence = closest(conf, CONFIDENCES);
  if (confidence === undefined) return `confidence ${String(r.confidence)} is not one of ${CONFIDENCES.join("/")}`;
  const effort = Number(r.effort);
  if (!Number.isFinite(effort) || effort <= 0 || effort > 60) return `effort ${String(r.effort)} is not 0–60 days`;
  const blast = BLASTS.find((b) => b === r.blast);
  if (!blast) return `blast ${String(r.blast)} is not green/yellow/red`;
  const repo = typeof r.repo === "string" && repos.includes(r.repo) ? r.repo : undefined;
  const why = typeof r.why === "string" ? r.why : "";
  return { reach, impact, confidence, effort, blast, repo, why };
}

/** Scores keyed by card number (1-based, as in the prompt). */
export function parseTriage(text: string, count: number, repos: string[]): { scores: Map<number, TriageScore>; dropped: string[]; error?: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let data: { cards?: unknown };
  try {
    data = JSON.parse(candidate) as { cards?: unknown };
  } catch {
    return { scores: new Map(), dropped: [], error: "triage reply was not JSON" };
  }
  const scores = new Map<number, TriageScore>();
  const dropped: string[] = [];
  for (const raw of Array.isArray(data.cards) ? data.cards : []) {
    const n = Number((raw as { n?: unknown })?.n);
    if (!Number.isInteger(n) || n < 1 || n > count) {
      dropped.push(`unknown card number ${String((raw as { n?: unknown })?.n)}`);
      continue;
    }
    const v = vetScore(raw, repos);
    if (typeof v === "string") dropped.push(`card ${n}: ${v}`);
    else scores.set(n, v);
  }
  return { scores, dropped };
}

export interface TriageResult {
  scores: Map<number, TriageScore>;
  dropped: string[];
  error?: string;
  costUsd?: number;
}

/** One headless call that scores a batch of Backlog cards. No tools: card text and repo notes only. */
export async function triage(cfg: Config, cards: TriageCard[]): Promise<TriageResult> {
  const repos = Object.values(cfg.repos);
  const notes = await Promise.all(
    repos.map(async (r) => ({ name: r.name, notes: (await fromTarget(r, "CLAUDE.md")).slice(0, REPO_NOTES_CHARS) })),
  );
  const res = await callClaude(cfg, {
    cwd: (cfg.defaultRepo ? cfg.repos[cfg.defaultRepo] : repos[0])!.path,
    prompt: triagePrompt(cards, notes),
    allowedTools: [],
    disallowedTools: [...new Set([...cfg.disallowedTools, "Bash", "Edit", "Write", "NotebookEdit"])],
    permissionMode: cfg.reviewPermissionMode,
    timeoutMs: 5 * 60_000,
  });
  if (!res.ok) return { scores: new Map(), dropped: [], error: `triage failed: ${res.error}`, costUsd: res.costUsd };
  return { ...parseTriage(res.text, cards.length, repos.map((r) => r.name)), costUsd: res.costUsd };
}
