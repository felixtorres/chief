import { computeStats, type LedgerEvent } from "./ledger.js";
import type { Note } from "./notify.js";

export const MORNING_MARKER = "<!-- chief:morning -->";
const DAY_MS = 24 * 3600_000;
const MAX_TITLES = 5;

/** What is on the board right now and needs you. */
export interface BoardSnapshot {
  pass: string[];
  blocked: string[];
  recipes: number;
}

function pct(n: number, of: number): string {
  return of ? `${Math.round((100 * n) / of)}%` : "–";
}

function titles(list: string[]): string {
  const shown = list.slice(0, MAX_TITLES).join("; ");
  return list.length > MAX_TITLES ? `${shown}; +${list.length - MAX_TITLES} more` : shown;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Yesterday (local midnight to midnight) from the ledger, what is waiting on the board now,
 * and on `weekly` days a one-line week summary. `note` is undefined on a quiet day.
 */
export function morningSummary(
  events: LedgerEvent[],
  board: BoardSnapshot,
  now = new Date(),
  weekly = false,
): { block: string; note?: Note } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - DAY_MS);
  const y = computeStats(events, { since: yesterday, until: today });
  const lines: string[] = [];

  if (y.attempts || y.served || y.abandoned || y.reverted) {
    const parts: string[] = [];
    if (y.attempts) parts.push(`${plural(y.attempts, "run")} (${y.passed} passed, ${y.blocked} blocked)`);
    if (y.served) parts.push(`${y.served} merged${y.corrected ? `, ${y.corrected} with your edits` : ""}`);
    if (y.abandoned) parts.push(`${y.abandoned} abandoned`);
    if (y.reverted) parts.push(`${y.reverted} reverted`);
    if (y.costUsd) parts.push(`$${y.costUsd.toFixed(2)}`);
    lines.push(`Yesterday: ${parts.join(" · ")}`);
  }
  if (board.pass.length) lines.push(`At the Pass, waiting for your review: ${titles(board.pass)}`);
  if (board.blocked.length) lines.push(`Blocked: ${titles(board.blocked)}`);
  if (board.recipes) lines.push(`${plural(board.recipes, "recipe")} to approve or reject in the Recipes lane`);

  if (weekly) {
    const since = new Date(today.getTime() - 7 * DAY_MS);
    const w = computeStats(events, { since, until: today });
    if (w.attempts || w.served) {
      const prev = computeStats(events, { since: new Date(since.getTime() - 7 * DAY_MS), until: since });
      const was = prev.attempts ? ` (was ${pct(prev.firstPass, prev.attempts)})` : "";
      lines.push(
        `Last week: ${plural(w.attempts, "run")} · first-pass ${pct(w.firstPass, w.attempts)}${was} · ${w.served} merged · $${w.costUsd.toFixed(2)}. Full table in today's digest.`,
      );
    }
  }

  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const block = ["", MORNING_MARKER, `## ☀️ Morning · ${date}`, "", ...(lines.length ? lines.map((l) => `- ${l}`) : ["- Quiet: nothing ran yesterday and nothing is waiting."]), ""].join("\n");
  if (!lines.length) return { block };

  const waiting = [
    board.pass.length ? `${board.pass.length} at the Pass` : "",
    board.blocked.length ? `${board.blocked.length} blocked` : "",
    board.recipes ? plural(board.recipes, "recipe") : "",
  ].filter(Boolean);
  return {
    block,
    note: { title: `Good morning${waiting.length ? `: ${waiting.join(", ")}` : ""}`, body: lines.join("\n"), digest: false },
  };
}
