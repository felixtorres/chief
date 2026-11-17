import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Chief } from "../src/chief.js";
import { parseConfig } from "../src/config.js";
import { appendLedger, weeklyStatsBlock, type LedgerEvent } from "../src/ledger.js";
import { writeWeeklyStats } from "../src/notify.js";
import { StateStore } from "../src/state.js";
import { tmp } from "./helpers.js";

// Local time, like the digest file names. 2026-11-16 is a Monday.
const MONDAY = new Date(2026, 10, 16, 9, 0);
const local = (day: number, hour = 12) => new Date(2026, 10, day, hour).toISOString();
const run = (over: Partial<Extract<LedgerEvent, { kind: "run" }>>): LedgerEvent => ({
  kind: "run", at: local(12), id: "a", repo: "api", status: "pass", rounds: 1, ...over,
});

const EVENTS: LedgerEvent[] = [
  // last week: Mon 9 → Sun 15
  run({ id: "a", at: local(9, 0), rounds: 1, costUsd: 0.5 }),
  run({ id: "b", at: local(15, 23), status: "blocked", rounds: 3, category: "review", denials: 1, costUsd: 1.5 }),
  run({ id: "w", repo: "web", rounds: 2, ruleFiles: ["CLAUDE.md"], costUsd: 1 }),
  { kind: "served", at: local(13), id: "a", repo: "api" },
  // the week before: one 2-round pass
  run({ id: "old", at: local(4), rounds: 2, costUsd: 1 }),
  // today and later: not part of last week
  run({ id: "today", at: local(16, 8) }),
];

describe("weeklyStatsBlock", () => {
  it("covers the 7 full days before today, per repo plus a total, compared with the week before", () => {
    const block = weeklyStatsBlock(EVENTS, ["api", "web", "idle"], MONDAY)!;
    expect(block).toContain("## 📊 Weekly stats · 2026-11-09 → 2026-11-15");
    expect(block).toContain("| api | 2 | 50% | 50% | 2.0 | 1 (review 1) | 1 / 0 | $2.00 |");
    expect(block).toContain("| web | 1 | 100% | 0% | 2.0 | 0 | 0 / 0 | $1.00 |");
    expect(block).toContain("| **all** | 3 | 67% | 33% | 2.0 | 1 (review 1) | 1 / 0 | $3.00 |");
    expect(block).not.toContain("| idle |");
    expect(block).toContain("First-pass 33% vs 0% the week before; mean rounds 2.0 vs 2.0.");
    expect(block).toContain("1 attempt(s) hit allowlist denials.");
    expect(block).toContain("1 attempt(s) edited agent rule files (🔴).");
  });

  it("skips the total row for a single active repo, and returns nothing for an empty week", () => {
    const one = weeklyStatsBlock([run({})], ["api", "web"], MONDAY)!;
    expect(one).toContain("| api |");
    expect(one).not.toContain("**all**");
    expect(one).toContain("No runs the week before to compare with.");
    expect(one).toContain("Cost reported on 0 of 1 attempts.");
    expect(weeklyStatsBlock([run({ at: local(1) })], ["api"], MONDAY)).toBeUndefined();
  });
});

function setup(extra: Record<string, unknown> = {}) {
  const root = tmp();
  const cfg = parseConfig({
    boardPath: join(root, "board.md"),
    digestDir: join(root, "digests"),
    ledgerFile: join(root, "ledger.jsonl"),
    stateFile: join(root, "state.json"),
    repos: { api: { path: "/api" }, web: { path: "/web" } },
    ...extra,
  });
  for (const e of EVENTS) appendLedger(cfg.ledgerFile, e);
  return cfg;
}

describe("weekly stats in the digest", () => {
  it("writes the block once per day, after the day's other entries", () => {
    const cfg = setup();
    const file = writeWeeklyStats(cfg, MONDAY)!;
    expect(file).toBe(join(cfg.digestDir, "2026-11-16.md"));
    expect(writeWeeklyStats(cfg, MONDAY)).toBeUndefined();
    expect(readFileSync(file, "utf8").match(/Weekly stats/g)).toHaveLength(1);
  });

  it("is written by the daemon only on the configured weekday, and can be turned off", () => {
    const cfg = setup();
    const chief = new Chief(cfg, new StateStore(cfg.stateFile), () => {}, async () => {});
    expect(chief.weeklyStats(new Date(2026, 10, 17, 9))).toBeUndefined(); // Tuesday
    expect(chief.weeklyStats(MONDAY)).toBe(join(cfg.digestDir, "2026-11-16.md"));

    const sunday = setup({ weeklyStatsDay: 0 });
    const c2 = new Chief(sunday, new StateStore(sunday.stateFile), () => {}, async () => {});
    expect(c2.weeklyStats(MONDAY)).toBeUndefined();
    expect(c2.weeklyStats(new Date(2026, 10, 15, 9))).toBeDefined();

    const off = setup({ weeklyStatsDay: false });
    expect(off.weeklyStatsDay).toBeUndefined();
    expect(new Chief(off, new StateStore(off.stateFile), () => {}, async () => {}).weeklyStats(MONDAY)).toBeUndefined();
  });

  it("rejects a weekday outside 0–6", () => {
    expect(() => setup({ weeklyStatsDay: 7 })).toThrow(/0–6/);
    expect(() => setup({ weeklyStatsDay: "monday" })).toThrow(/0–6/);
  });
});
