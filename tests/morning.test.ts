import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Board } from "../src/board.js";
import { Chief } from "../src/chief.js";
import { appendLedger, type LedgerEvent } from "../src/ledger.js";
import { morningSummary, MORNING_MARKER } from "../src/morning.js";
import type { Note } from "../src/notify.js";
import { StateStore } from "../src/state.js";
import { makeConfig, makeRepo, resetFakeEnv, tmp } from "./helpers.js";

// 2026-11-16 is a Monday; "yesterday" is Sunday the 15th.
const MONDAY = new Date(2026, 10, 16, 8, 30);
const TUESDAY = new Date(2026, 10, 17, 8, 30);
const local = (day: number, hour = 12) => new Date(2026, 10, day, hour).toISOString();
const run = (over: Partial<Extract<LedgerEvent, { kind: "run" }>>): LedgerEvent => ({
  kind: "run", at: local(15), id: "a", repo: "demo", status: "pass", rounds: 1, costUsd: 0.5, ...over,
});

const EVENTS: LedgerEvent[] = [
  run({ id: "a" }),
  run({ id: "b", status: "blocked", rounds: 3, category: "checks", costUsd: 1 }),
  { kind: "served", at: local(15, 16), id: "c", repo: "demo" },
  { kind: "corrected", at: local(15, 16), id: "c", repo: "demo", files: 1, insertions: 2, deletions: 1 },
  run({ id: "old", at: local(10), rounds: 2 }),
  run({ id: "older", at: local(5) }),
  run({ id: "today", at: local(16, 7) }),
];
const EMPTY = { pass: [], blocked: [], recipes: 0 };

beforeEach(resetFakeEnv);

describe("morningSummary", () => {
  it("reports yesterday and what is waiting on the board", () => {
    const m = morningSummary(EVENTS, { pass: ["Fix login"], blocked: ["Add SSO"], recipes: 2 }, TUESDAY);
    const lines = m.note!.body.split("\n");
    expect(lines[0]).toBe("Yesterday: 1 run (1 passed, 0 blocked) · $0.50");
    expect(lines.slice(1)).toEqual([
      "At the Pass, waiting for your review: Fix login",
      "Blocked: Add SSO",
      "2 recipes to approve or reject in the Recipes lane",
    ]);
    expect(m.note!.title).toBe("Good morning: 1 at the Pass, 1 blocked, 2 recipes");
    expect(m.note!.digest).toBe(false);
    expect(m.block).toContain(MORNING_MARKER);
    expect(m.block).toContain("## ☀️ Morning · 2026-11-17");
  });

  it("adds a one-line week on the weekly day", () => {
    const m = morningSummary(EVENTS, EMPTY, MONDAY, true);
    const lines = m.note!.body.split("\n");
    expect(lines[0]).toBe("Yesterday: 2 runs (1 passed, 1 blocked) · 1 merged, 1 with your edits · $1.50");
    expect(lines[1]).toBe("Last week: 3 runs · first-pass 33% (was 100%) · 1 merged · $2.00. Full table in today's digest.");
    expect(m.note!.title).toBe("Good morning");
  });

  it("caps long title lists and stays quiet on a quiet day", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"];
    expect(morningSummary([], { ...EMPTY, pass: many }, MONDAY).note!.body).toBe("At the Pass, waiting for your review: a; b; c; d; e; +2 more");
    const quiet = morningSummary([], EMPTY, MONDAY);
    expect(quiet.note).toBeUndefined();
    expect(quiet.block).toContain("Quiet: nothing ran yesterday and nothing is waiting.");
  });
});

describe("Chief.morningDigest", () => {
  function setup(hour: number | false = 8) {
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = makeConfig(root, repo, { morningDigestHour: hour, weeklyStatsDay: false });
    const b = Board.parse(readFileSync(new URL("../templates/board.example.md", import.meta.url), "utf8"));
    for (const lane of b.lanes) lane.cards = [];
    writeFileSync(cfg.boardPath, b.render().replace("## Pass\n\n", "## Pass\n\n- [ ] Fix login #chief-abc123<br>🤖 🔍 🟢 green\n- [x] Old one\n"));
    for (const e of EVENTS) appendLedger(cfg.ledgerFile, e);
    const notes: Note[] = [];
    const chief = new Chief(cfg, new StateStore(cfg.stateFile), () => {}, async (_c, n) => notes.push(n));
    return { cfg, chief, notes };
  }

  it("goes out once a day from the configured hour, into the digest and to the notifier", async () => {
    const { cfg, chief, notes } = setup(8);
    expect(await chief.morningDigest(new Date(2026, 10, 16, 7, 59))).toBeUndefined();
    expect(notes).toHaveLength(0);

    await chief.morningDigest(MONDAY);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("Good morning: 1 at the Pass");
    expect(notes[0]!.body).toContain("At the Pass, waiting for your review: Fix login");
    expect(notes[0]!.body).not.toContain("Old one");

    await chief.morningDigest(new Date(2026, 10, 16, 15, 0));
    expect(notes).toHaveLength(1);
    const digest = readFileSync(join(cfg.digestDir, "2026-11-16.md"), "utf8");
    expect(digest.split(MORNING_MARKER)).toHaveLength(2);

    await chief.morningDigest(new Date(2026, 10, 16, 15, 0), true);
    expect(notes).toHaveLength(2);
  });

  it("is off when morningDigestHour is false", async () => {
    const { chief, notes } = setup(false);
    expect(await chief.morningDigest(MONDAY)).toBeUndefined();
    expect(notes).toHaveLength(0);
  });
});
