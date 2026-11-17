import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLedger, categorize, computeStats, formatStats, readLedger, type LedgerEvent } from "../src/ledger.js";
import { tmp } from "./helpers.js";

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12)).toISOString();
const run = (over: Partial<Extract<LedgerEvent, { kind: "run" }>>): LedgerEvent => ({
  kind: "run", at: at(10), id: "a", repo: "api", status: "pass", rounds: 1, ...over,
});

describe("categorize", () => {
  it("maps blocked reasons to coarse categories", () => {
    expect(categorize("BLOCKED: which env?")).toBe("question");
    expect(categorize("worker failed: boom")).toBe("worker-error");
    expect(categorize("Chief error: git failed")).toBe("chief-error");
    expect(categorize("work is ready on branch x but the PR step failed: 401")).toBe("pr");
    expect(categorize("reviewer failed: timeout")).toBe("review-error");
    expect(categorize("unparseable review: hi")).toBe("review-error");
    expect(categorize("did not converge after 3 rounds; last feedback: Checks failed: ...")).toBe("checks");
    expect(categorize("did not converge after 3 rounds; last feedback: Reviewer requested changes: ...")).toBe("review");
    expect(categorize("interrupted: Chief restarted mid-run")).toBe("interrupted");
    expect(categorize("something new")).toBe("other");
  });
});

describe("ledger", () => {
  it("appends and reads events, skipping torn lines", () => {
    const file = join(tmp(), "nested", "ledger.jsonl");
    appendLedger(file, run({}));
    appendLedger(file, { kind: "served", at: at(11), id: "a", repo: "api" });
    expect(readLedger(file).map((e) => e.kind)).toEqual(["run", "served"]);
    expect(readLedger(join(tmp(), "missing.jsonl"))).toEqual([]);
  });

  it("computes pass, first-pass, rounds, blocked reasons and cost within the window and repo", () => {
    const events: LedgerEvent[] = [
      run({ id: "a", rounds: 1, costUsd: 0.5 }),
      run({ id: "b", rounds: 3, costUsd: 1.5, denials: 2 }),
      run({ id: "c", status: "blocked", rounds: 2, category: "checks", ruleFiles: ["REVIEW.md"] }),
      run({ id: "c", status: "blocked", rounds: 0, category: "interrupted" }),
      run({ id: "old", at: at(1) }),
      run({ id: "web", repo: "web" }),
      { kind: "served", at: at(12), id: "a", repo: "api" },
      { kind: "abandoned", at: at(12), id: "b", repo: "api" },
    ];
    const s = computeStats(events, { repo: "api", since: new Date(at(5)) });
    expect(s).toMatchObject({
      attempts: 4, cards: 3, passed: 2, firstPass: 1, blocked: 2, withDenials: 1, ruleFileEdits: 1,
      served: 1, abandoned: 1, costUsd: 2, costReported: 2, blockedBy: { checks: 1, interrupted: 1 },
    });
    expect(s.meanRounds).toBeCloseTo(2);
    const text = formatStats(s, 4);
    expect(text).toContain("repo api");
    expect(text).toMatch(/first-pass\s+1\s+25%/);
    expect(text).toMatch(/blocked\s+2\s+50%\s+checks 1 · interrupted 1/);
    expect(text).toContain("(reported on 2 of 4)");
  });

  it("says so when there is nothing to report", () => {
    expect(formatStats(computeStats([], { since: new Date(0) }), 1)).toContain("no runs yet");
  });
});
