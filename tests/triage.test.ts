import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { Board, readBoard } from "../src/board.js";
import { Chief } from "../src/chief.js";
import { readLedger } from "../src/ledger.js";
import { parseTriage, rice, triageStatus, vetScore } from "../src/triage.js";
import { StateStore } from "../src/state.js";
import { fakeCalls, makeConfig, makeRepo, resetFakeEnv, tmp } from "./helpers.js";

const STARTER = readFileSync(new URL("../templates/board.example.md", import.meta.url), "utf8");

function setup(backlog: string[], ready: string[] = []) {
  const root = tmp();
  const repo = makeRepo(root);
  const cfg = makeConfig(root, repo, { triage: true, repos: { demo: { path: repo }, web: { path: repo } } });
  const b = Board.parse(STARTER);
  for (const lane of b.lanes) lane.cards = [];
  let text = b.render();
  text = text.replace("## Backlog\n\n", `## Backlog\n\n${backlog.join("\n")}\n`);
  text = text.replace("## Ready\n\n", `## Ready\n\n${ready.join("\n")}\n`);
  writeFileSync(cfg.boardPath, Board.parse(text).render());
  const chief = new Chief(cfg, new StateStore(cfg.stateFile), () => {}, async () => {});
  return { cfg, chief };
}

const score = (n: number, over: Record<string, unknown> = {}) => ({ n, reach: 4, impact: 2, confidence: 0.8, effort: 1, blast: "yellow", repo: null, why: "touches the login flow", ...over });

beforeEach(resetFakeEnv);

describe("RICE scoring", () => {
  it("computes reach × impact × confidence ÷ effort and renders one status line", () => {
    const s = { reach: 4, impact: 2, confidence: 0.8, effort: 1, blast: "yellow" as const, why: "touches the login flow" };
    expect(rice(s)).toBeCloseTo(6.4);
    expect(triageStatus(s)).toBe("📊 RICE 6.4 · R4 I2 C80% E1d · 🟡 yellow · touches the login flow");
    expect(triageStatus({ ...s, reach: 10, impact: 3, confidence: 1, effort: 0.5, repo: "web", why: "" })).toBe(
      "📊 RICE 60 · R10 I3 C100% E0.5d · 🟡 yellow · suggest repo web",
    );
  });

  it("drops out-of-range values and unknown repos instead of guessing", () => {
    expect(vetScore(score(1, { reach: 11 }), [])).toMatch(/reach/);
    expect(vetScore(score(1, { impact: 1.5 }), [])).toMatch(/impact/);
    expect(vetScore(score(1, { effort: 0 }), [])).toMatch(/effort/);
    expect(vetScore(score(1, { blast: "orange" }), [])).toMatch(/blast/);
    expect(vetScore(score(1, { confidence: 80 }), [])).toMatchObject({ confidence: 0.8 });
    expect(vetScore(score(1, { repo: "nope" }), ["web"])).toMatchObject({ repo: undefined });
    expect(vetScore(score(1, { repo: "web" }), ["web"])).toMatchObject({ repo: "web" });
  });

  it("parses a fenced reply keyed by card number", () => {
    const reply = "```json\n" + JSON.stringify({ cards: [score(1), score(2, { reach: 0 }), score(7)] }) + "\n```";
    const res = parseTriage(reply, 2, []);
    expect([...res.scores.keys()]).toEqual([1]);
    expect(res.dropped).toEqual(["card 2: reach 0 is not 1–10", "unknown card number 7"]);
    expect(parseTriage("no json here", 1, []).error).toBe("triage reply was not JSON");
  });
});

describe("Chief.triageBacklog", () => {
  it("scores only unscored, open Backlog cards in one call and never moves them", async () => {
    const { cfg, chief } = setup([
      "- [ ] Fix login redirect #repo/demo",
      "- [ ] Add dark mode",
      "- [ ] Already scored<br>🤖 📊 RICE 1 · R1 I1 C100% E1d · 🟢 green",
      "- [x] Done already",
    ]);
    process.env.FAKE_TRIAGE = JSON.stringify({ cards: [score(1), score(2, { blast: "green", repo: "web", why: "UI only" })] });
    expect(await chief.triageBacklog()).toBe(2);

    const calls = fakeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("[1] Fix login redirect (repo: demo)");
    expect(calls[0]!.prompt).toContain("[2] Add dark mode (no repo tag)");
    expect(calls[0]!.prompt).not.toContain("Already scored");
    expect(calls[0]!.prompt).not.toContain("Done already");

    const backlog = readBoard(cfg.boardPath).lane("Backlog")!.cards;
    expect(backlog.map((c) => c.status)).toEqual([
      "📊 RICE 6.4 · R4 I2 C80% E1d · 🟡 yellow · touches the login flow",
      "📊 RICE 6.4 · R4 I2 C80% E1d · 🟢 green · suggest repo web · UI only",
      "📊 RICE 1 · R1 I1 C100% E1d · 🟢 green",
      "",
    ]);
    expect(backlog[0]!.title).toBe("Fix login redirect #repo/demo");
    expect(readLedger(cfg.ledgerFile)).toEqual([expect.objectContaining({ kind: "triage", cards: 2, scored: 2, costUsd: 0.25 })]);
  });

  it("waits for the interval between calls, unless forced; --all re-scores", async () => {
    const { cfg, chief } = setup(["- [ ] One"]);
    process.env.FAKE_TRIAGE = JSON.stringify({ cards: [score(1)] });
    expect(await chief.triageBacklog()).toBe(1);
    writeFileSync(cfg.boardPath, readFileSync(cfg.boardPath, "utf8").replace("- [ ] One<br>", "- [ ] Two\n- [ ] One<br>"));
    expect(await chief.triageBacklog()).toBe(0);
    expect(fakeCalls()).toHaveLength(1);

    process.env.FAKE_TRIAGE = JSON.stringify({ cards: [score(1, { reach: 1 }), score(2, { reach: 2 })] });
    expect(await chief.triageBacklog({ force: true, all: true })).toBe(2);
    expect(readBoard(cfg.boardPath).lane("Backlog")!.cards.map((c) => c.status.slice(0, 12))).toEqual(["📊 RICE 1.6 ", "📊 RICE 3.2 "]);
  });

  it("leaves the board alone when the reply is unusable", async () => {
    const { cfg, chief } = setup(["- [ ] One"]);
    process.env.FAKE_TRIAGE = "sorry, no";
    const before = readFileSync(cfg.boardPath, "utf8");
    expect(await chief.triageBacklog()).toBe(0);
    expect(readFileSync(cfg.boardPath, "utf8")).toBe(before);
    expect(readLedger(cfg.ledgerFile)[0]).toMatchObject({ kind: "triage", scored: 0, error: "triage reply was not JSON" });
  });

  it("runs from tick only when nothing is Ready", async () => {
    const { chief } = setup(["- [ ] Idea"], ["- [ ] Cook me #repo/demo"]);
    process.env.FAKE_TRIAGE = JSON.stringify({ cards: [score(1)] });
    expect(await chief.tick()).toBe(true);
    expect(fakeCalls().some((c) => c.prompt.includes("EXPEDITER"))).toBe(false);
    expect(await chief.tick()).toBe(false);
    expect(fakeCalls().filter((c) => c.prompt.includes("EXPEDITER"))).toHaveLength(1);
  });
});
