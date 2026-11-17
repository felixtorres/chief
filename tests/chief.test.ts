import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { adoFor } from "../src/ado.js";
import { Board, readBoard } from "../src/board.js";
import { Chief } from "../src/chief.js";
import { parseConfig } from "../src/config.js";
import type { Note } from "../src/notify.js";
import { appendDigest } from "../src/notify.js";
import { readLedger } from "../src/ledger.js";
import { StateStore } from "../src/state.js";
import { makeConfig, makeRepo, resetFakeEnv, tmp } from "./helpers.js";

const STARTER = readFileSync(new URL("../templates/board.example.md", import.meta.url), "utf8");

function boardWith(lanes: Record<string, string[]>): string {
  const b = Board.parse(STARTER);
  for (const lane of b.lanes) lane.cards = [];
  let text = b.render();
  for (const [lane, cards] of Object.entries(lanes)) {
    text = text.replace(`## ${lane}\n\n`, `## ${lane}\n\n${cards.map((c) => `- [ ] ${c}`).join("\n")}\n`);
  }
  return Board.parse(text).render();
}

function setup(lanes: Record<string, string[]>, overrides: Record<string, unknown> = {}) {
  const root = tmp();
  const repo = makeRepo(root);
  const cfg = makeConfig(root, repo, overrides);
  writeFileSync(cfg.boardPath, boardWith(lanes));
  const state = new StateStore(cfg.stateFile);
  const notes: Note[] = [];
  const chief = new Chief(cfg, state, () => {}, async (_c, n) => notes.push(n));
  return { cfg, state, chief, notes };
}

beforeEach(resetFakeEnv);

describe("Chief.tick", () => {
  it("cooks the first Ready card and moves it to Pass with status, state and a notification", async () => {
    const { cfg, chief, state, notes } = setup({ Ready: ["Add feature file #repo/demo", "Second card"] });
    expect(await chief.tick()).toBe(true);

    const board = readBoard(cfg.boardPath);
    const card = board.lane("Pass")!.cards[0]!;
    expect(card.cleanTitle).toBe("Add feature file");
    expect(card.status).toMatch(/^🔍 🟢 green · branch `chief\/([0-9a-f]{6})-add-feature-file` · 1 round · \[\[chief-\1\|run log\]\]$/);
    expect(board.lane("Ready")!.cards.map((c) => c.cleanTitle)).toEqual(["Second card"]);

    const run = state.get(card.id!)!;
    expect(run).toMatchObject({ status: "pass", repo: "demo", rounds: 1, blast: "green" });
    expect(notes[0]!.title).toBe("Ready at the pass: Add feature file");

    const ledger = readLedger(cfg.ledgerFile);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: "run", id: card.id, repo: "demo", status: "pass", rounds: 1, blast: "green", costUsd: 0.5 });
  });

  it("records blocked attempts in the ledger with a category", async () => {
    process.env.FAKE_WORKER = "blocked";
    const { cfg, chief } = setup({ Ready: ["Ambiguous thing"] });
    await chief.tick();
    expect(readLedger(cfg.ledgerFile)[0]).toMatchObject({ status: "blocked", category: "question" });
  });

  it("never touches Backlog cards on its own", async () => {
    const { cfg, chief } = setup({ Backlog: ["Just an idea"] });
    expect(await chief.tick()).toBe(false);
    expect(readFileSync(cfg.boardPath, "utf8")).toBe(boardWith({ Backlog: ["Just an idea"] }));
  });

  it("can cook a specific Backlog card when asked by name", async () => {
    const { cfg, chief } = setup({ Backlog: ["Just an idea", "Add feature file"] });
    expect(await chief.tick("feature")).toBe(true);
    const board = readBoard(cfg.boardPath);
    expect(board.lane("Pass")!.cards[0]!.cleanTitle).toBe("Add feature file");
    expect(board.lane("Backlog")!.cards.map((c) => c.cleanTitle)).toEqual(["Just an idea"]);
  });

  it("blocks a card whose repo is unknown without running a worker", async () => {
    const { cfg, chief, notes } = setup({ Ready: ["Mystery #repo/nope"] });
    await chief.tick();
    const card = readBoard(cfg.boardPath).lane("Blocked")!.cards[0]!;
    expect(card.status).toContain('unknown repo "nope"');
    expect(notes[0]!.title).toBe("Blocked: Mystery");
  });

  it("blocks when there is no repo tag and no defaultRepo", async () => {
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = { ...makeConfig(root, repo), defaultRepo: undefined };
    writeFileSync(cfg.boardPath, boardWith({ Ready: ["Untagged"] }));
    const chief = new Chief(cfg, new StateStore(cfg.stateFile), () => {}, async () => {});
    await chief.tick();
    expect(readBoard(cfg.boardPath).lane("Blocked")!.cards[0]!.status).toContain("#repo/<name>");
  });

  it("moves worker BLOCKED questions to the Blocked lane", async () => {
    process.env.FAKE_WORKER = "blocked";
    const { cfg, chief } = setup({ Ready: ["Ambiguous thing"] });
    await chief.tick();
    const card = readBoard(cfg.boardPath).lane("Blocked")!.cards[0]!;
    expect(card.status).toBe(`🚧 BLOCKED: which environment should this target? · [[chief-${card.id}|run log]]`);
  });

  it("errors clearly if the board lacks a required lane", async () => {
    const { cfg, chief } = setup({ Ready: ["x"] });
    writeFileSync(cfg.boardPath, readFileSync(cfg.boardPath, "utf8").replace("## Blocked", "## Parking"));
    await expect(chief.tick()).rejects.toThrow(/missing the "Blocked" lane/);
  });
});

describe("Chief.recover", () => {
  it("moves cards left in Cooking to Blocked after a restart", () => {
    const { cfg, chief, state } = setup({ Cooking: ["Half done #chief-aaaaaa"] });
    state.upsert({ id: "aaaaaa", title: "Half done", repo: "demo", status: "cooking" });
    expect(chief.recover()).toBe(1);
    expect(state.get("aaaaaa")!.status).toBe("blocked");
    const card = readBoard(cfg.boardPath).lane("Blocked")!.cards[0]!;
    expect(card.status).toMatch(/interrupted/);
  });
});

describe("config + digest", () => {
  it("rejects configs without repos or with a bad defaultRepo", () => {
    expect(() => parseConfig({ boardPath: "/b", repos: {} })).toThrow(/at least one repo/);
    expect(() => parseConfig({ boardPath: "/b", repos: { a: { path: "/a" } }, defaultRepo: "b" })).toThrow(/not in repos/);
    expect(() => parseConfig({ repos: { a: { path: "/a" } } })).toThrow(/boardPath/);
  });

  it("lets a repo override the top-level ado org/project", () => {
    const cfg = parseConfig({
      boardPath: "/b",
      ado: { org: "https://dev.azure.com/top", project: "Top" },
      repos: { a: { path: "/a", ado: { org: "https://dev.azure.com/other" } }, b: { path: "/b" } },
    });
    expect(adoFor(cfg, cfg.repos.a!)).toEqual({ org: "https://dev.azure.com/other", project: "Top" });
    expect(adoFor(cfg, cfg.repos.b!)).toEqual({ org: "https://dev.azure.com/top", project: "Top" });
  });

  it("appends one line per event to the daily digest", () => {
    const root = tmp();
    const cfg = parseConfig({ boardPath: "/b", digestDir: join(root, "d"), repos: { a: { path: "/a" } } });
    const when = new Date(2026, 10, 15, 9, 5);
    const file = appendDigest(cfg, { title: "Ready", body: "line one\nline two", url: "https://x/pr/1" }, when);
    appendDigest(cfg, { title: "Blocked", body: "why" }, when);
    expect(file).toMatch(/2026-11-15\.md$/);
    expect(readFileSync(file, "utf8")).toBe("- 09:05 **Ready**: line one line two [PR](https://x/pr/1)\n- 09:05 **Blocked**: why\n");
  });
});

describe("fitDescription", () => {
  it("leaves short descriptions alone and cuts long ones at a line under the limit", async () => {
    const { fitDescription } = await import("../src/ado.js");
    expect(fitDescription("short\n\ntext")).toBe("short\n\ntext");
    const long = ["## Summary", "kept", "", ...Array.from({ length: 200 }, (_, i) => `- step ${i} ${"x".repeat(30)}`)].join("\n");
    const fitted = fitDescription(long);
    expect(fitted.split("\n").map((l) => (l === "" ? " " : l)).join("\n").length).toBeLessThanOrEqual(4000);
    expect(fitted.startsWith("## Summary\nkept\n")).toBe(true);
    expect(fitted).toMatch(/Description shortened/);
  });
});

describe("Chief.cleanUp", () => {
  it("removes a Served card's worktree and chief/ branch, and leaves other paths alone", async () => {
    const { existsSync, mkdirSync } = await import("node:fs");
    const { git } = await import("../src/run.js");
    const { cfg, chief, state } = setup({ Ready: ["Add feature file"] });
    await chief.tick();
    const run = state.byStatus("pass")[0]!;
    expect(existsSync(run.worktree!)).toBe(true);
    const repoPath = cfg.repos.demo!.path;

    state.upsert({ id: run.id, status: "served" });
    await chief.cleanUp(run.id);
    expect(existsSync(run.worktree!)).toBe(false);
    expect((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}`], repoPath)).code).not.toBe(0);
    expect(state.get(run.id)!.worktree).toBeUndefined();

    const outside = join(tmp(), "mine");
    mkdirSync(outside);
    state.upsert({ id: run.id, worktree: outside, branch: "feature/mine" });
    await chief.cleanUp(run.id);
    expect(existsSync(outside)).toBe(true);
  });
});

describe("#base/ tag", () => {
  it("stacks a card on another card's branch with #base/chief-<id>", async () => {
    const { git } = await import("../src/run.js");
    const { cfg, chief, state } = setup({ Ready: ["Add feature file"] });
    await chief.tick();
    const first = state.byStatus("pass")[0]!;
    const firstHead = (await git(["rev-parse", "HEAD"], first.worktree!)).stdout.trim();

    const text = readFileSync(cfg.boardPath, "utf8").replace("## Ready\n\n", `## Ready\n\n- [ ] Follow-up work #base/chief-${first.id}\n`);
    writeFileSync(cfg.boardPath, text);
    await chief.tick();
    const second = state.byStatus("pass").find((r) => r.id !== first.id)!;
    expect(second.title).toBe("Follow-up work");
    // The second card's branch contains the first card's commit.
    const contains = await git(["merge-base", "--is-ancestor", firstHead, "HEAD"], second.worktree!);
    expect(contains.code).toBe(0);
  });

  it("blocks when #base/ names a card Chief has no branch for, or a missing branch", async () => {
    const { cfg, chief } = setup({ Ready: ["Stacked #base/chief-abcdef", "Missing base #base/feature/nope"] });
    await chief.tick();
    await chief.tick();
    const blocked = readBoard(cfg.boardPath).lane("Blocked")!.cards;
    expect(blocked.map((c) => c.cleanTitle)).toEqual(expect.arrayContaining(["Stacked", "Missing base"]));
    expect(blocked.find((c) => c.cleanTitle === "Stacked")!.status).toContain("no branch for card #chief-abcdef");
    expect(blocked.find((c) => c.cleanTitle === "Missing base")!.status).toContain('base branch "feature/nope" was not found');
  });
});
