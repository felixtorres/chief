import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Board, Card, readBoard } from "../src/board.js";
import { Chief } from "../src/chief.js";
import { computeStats, formatStats, readLedger, type LedgerEvent } from "../src/ledger.js";
import { correctionDiff, findRevert } from "../src/learn.js";
import type { Note } from "../src/notify.js";
import { StateStore } from "../src/state.js";
import { fakeCalls, makeConfig, makeRepo, resetFakeEnv, tmp } from "./helpers.js";

const STARTER = readFileSync(new URL("../templates/board.example.md", import.meta.url), "utf8");
const ID = "abc123";
const BRANCH = `chief/${ID}-add-thing`;

const g = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();

function commit(repo: string, file: string, text: string, msg: string): string {
  writeFileSync(join(repo, file), text);
  g(repo, "add", file);
  g(repo, "commit", "-qm", msg);
  return g(repo, "rev-parse", "HEAD");
}

/**
 * A repo where Chief pushed one commit on its branch, you added a fix on top, and the PR
 * was merged into main. Returns the shas the fake ADO reports.
 */
function mergedPr(opts: { humanFix?: boolean; mainMergedIn?: boolean; reviewRules?: number } = {}) {
  const root = tmp();
  const repo = makeRepo(root);
  if (opts.reviewRules) {
    const rules = Array.from({ length: opts.reviewRules }, (_, i) => `- rule ${i}`).join("\n");
    commit(repo, "REVIEW.md", `# Review\n\n## Chief recipes\n\n${rules}\n`, "review rules");
  }
  g(repo, "checkout", "-qb", BRANCH);
  const pushedHead = commit(repo, "a.txt", "chief line\n", "chief: add thing");
  if (opts.mainMergedIn) {
    g(repo, "checkout", "-q", "main");
    commit(repo, "other.txt", "someone else's work\n", "unrelated change on main");
    g(repo, "checkout", "-q", BRANCH);
    g(repo, "merge", "-q", "--no-edit", "main");
  }
  let source = pushedHead;
  if (opts.humanFix) {
    commit(repo, "a.txt", "chief line\nhuman fix line\n", "fix: handle the empty case");
    source = commit(repo, "b.txt", "new helper\n", "add helper the card needed");
  }
  g(repo, "checkout", "-q", "main");
  g(repo, "merge", "-q", "--no-ff", "--no-edit", BRANCH);
  const mergeCommit = g(repo, "rev-parse", "HEAD");
  return { root, repo, pushedHead, source, mergeCommit };
}

function setup(repoRoot: string, repo: string, run: Record<string, unknown>, lane = "Pass", overrides: Record<string, unknown> = {}) {
  const cfg = makeConfig(repoRoot, repo, { openPr: true, ...overrides });
  const board = Board.parse(STARTER);
  for (const l of board.lanes) l.cards = [];
  board.lane(lane)!.cards.push(new Card(false, `Add thing #repo/demo #chief-${ID}`));
  writeFileSync(cfg.boardPath, board.render());
  mkdirSync(cfg.runsDir, { recursive: true });
  writeFileSync(join(cfg.runsDir, `chief-${ID}.md`), "# Chief run: Add thing\n\n## Attempt 1\n\n### Round 1\n\n**Review verdict:** approve\n");
  const state = new StateStore(cfg.stateFile);
  state.upsert({ id: ID, title: "Add thing", repo: "demo", status: "pass", prId: 7, prUrl: "https://ado/pr/7", branch: BRANCH, target: "main", rounds: 1, ...run });
  const notes: Note[] = [];
  const chief = new Chief(cfg, state, () => {}, async (_c, n) => notes.push(n));
  return { cfg, state, chief, notes };
}

const reflectorCalls = () => fakeCalls().filter((c) => c.prompt.includes("RECIPE KEEPER"));
const reply = (p: Record<string, unknown>) => JSON.stringify({ proposals: [p] });
const PROPOSAL = {
  kind: "claude-rule",
  text: "Handle the empty case in every new parser and add a test for it",
  why: "You added the empty-case fix by hand",
  evidence: [`chief-${ID}: human correction in a.txt`],
  dedupeKey: "handle-empty-case",
};

function prSays(details: Record<string, unknown>): void {
  process.env.FAKE_AZ_PR = JSON.stringify(details);
}

beforeEach(resetFakeEnv);

describe("correctionDiff", () => {
  it("diffs only the files your own commits touched, ignoring the target branch merged in", async () => {
    const { repo, pushedHead, source } = mergedPr({ humanFix: true, mainMergedIn: true });
    const c = await correctionDiff({ path: repo } as never, { pushedHead, branch: BRANCH }, source);
    expect(c).not.toBe("none");
    if (!c || c === "none") throw new Error("expected a correction");
    expect(c.files.sort()).toEqual(["a.txt", "b.txt"]);
    expect(c.insertions).toBe(2);
    expect(c.commits).toEqual(["add helper the card needed", "fix: handle the empty case"]);
    expect(c.patch).toContain("+human fix line");
    expect(c.patch).not.toContain("other.txt");
  });

  it("says none when the PR merged exactly what Chief pushed, and undefined when it can't tell", async () => {
    const { repo, pushedHead } = mergedPr();
    expect(await correctionDiff({ path: repo } as never, { pushedHead }, pushedHead)).toBe("none");
    expect(await correctionDiff({ path: repo } as never, {}, pushedHead)).toBeUndefined();
    expect(await correctionDiff({ path: repo } as never, { pushedHead, branch: "gone" })).toBeUndefined();
    expect(await correctionDiff({ path: repo } as never, { pushedHead }, "f".repeat(40))).toBeUndefined();
  });
});

describe("when a PR is merged", () => {
  it("records your correction, saves the diff, and reflects on it", async () => {
    const m = mergedPr({ humanFix: true });
    const { cfg, chief, state } = setup(m.root, m.repo, { pushedHead: m.pushedHead });
    prSays({ status: "completed", lastMergeSourceCommit: { commitId: m.source }, lastMergeCommit: { commitId: m.mergeCommit } });
    process.env.FAKE_REFLECT = reply(PROPOSAL);
    await chief.checkServed(true);

    expect(state.get(ID)).toMatchObject({ status: "served", corrected: true, mergeCommit: m.mergeCommit });
    const ledger = readLedger(cfg.ledgerFile);
    expect(ledger.find((e) => e.kind === "corrected")).toMatchObject({ files: 2, insertions: 2, deletions: 0 });
    expect(ledger.find((e) => e.kind === "reflect")).toMatchObject({ signal: "correction", proposals: 1 });
    expect(readFileSync(join(cfg.tracesDir, ID, "correction.diff"), "utf8")).toContain("+human fix line");

    const prompt = reflectorCalls()[0]!.prompt;
    expect(prompt).toContain("WHAT HAPPENED AFTER THE PR");
    expect(prompt).toContain("YOU (the human) pushed changes");
    expect(prompt).toContain('"fix: handle the empty case"');
    expect(prompt).toContain("RUN LOG:\n# Chief run: Add thing");

    const card = readBoard(cfg.boardPath).lane("Served")!.cards[0]!;
    expect(card.status).toBe("✅ merged · [PR !7](https://ado/pr/7) · ✏️ you edited 2 files");
    expect(readBoard(cfg.boardPath).lane("Recipes")!.cards[0]!.title).toContain("📖 CLAUDE.md: Handle the empty case");
  });

  it("does nothing extra when you merged it as Chief pushed it", async () => {
    const m = mergedPr();
    const { cfg, chief, state } = setup(m.root, m.repo, { pushedHead: m.pushedHead });
    prSays({ status: "completed", lastMergeSourceCommit: { commitId: m.pushedHead }, lastMergeCommit: { commitId: m.mergeCommit } });
    await chief.checkServed(true);
    expect(state.get(ID)!.corrected).toBe(false);
    expect(reflectorCalls()).toHaveLength(0);
    expect(readLedger(cfg.ledgerFile).some((e) => e.kind === "corrected")).toBe(false);
    expect(readBoard(cfg.boardPath).lane("Served")!.cards[0]!.status).toBe("✅ merged · [PR !7](https://ado/pr/7)");
  });

  it("still serves the card when the final commit can't be found", async () => {
    const m = mergedPr({ humanFix: true });
    const { chief, state } = setup(m.root, m.repo, { pushedHead: m.pushedHead });
    prSays({ status: "completed" });
    await chief.checkServed(true);
    expect(state.get(ID)).toMatchObject({ status: "served" });
    expect(state.get(ID)!.corrected).toBeUndefined();
  });

  it("warns on the card and in the prompt when the rule file is over budget", async () => {
    const m = mergedPr({ humanFix: true, reviewRules: 3 });
    const { cfg, chief } = setup(m.root, m.repo, { pushedHead: m.pushedHead }, "Pass", { recipeBudget: 2 });
    prSays({ status: "completed", lastMergeSourceCommit: { commitId: m.source }, lastMergeCommit: { commitId: m.mergeCommit } });
    process.env.FAKE_REFLECT = reply({ ...PROPOSAL, kind: "review-rule" });
    await chief.checkServed(true);
    expect(reflectorCalls()[0]!.prompt).toContain("Rule budget: REVIEW.md already has 3 Chief recipes (budget 2)");
    const notes = readBoard(cfg.boardPath).lane("Recipes")!.cards[0]!.notes;
    expect(notes).toContain("⚠ REVIEW.md already has 3 Chief recipes (budget 2): merge or drop some");
  });

  it("reflects on an abandoned PR", async () => {
    const m = mergedPr();
    const { cfg, chief } = setup(m.root, m.repo, { pushedHead: m.pushedHead });
    prSays({ status: "abandoned" });
    await chief.checkServed(true);
    expect(reflectorCalls()[0]!.prompt).toContain("PR was ABANDONED");
    expect(readLedger(cfg.ledgerFile).find((e) => e.kind === "reflect")).toMatchObject({ signal: "abandoned PR" });
  });
});

describe("reverts", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600_000).toISOString();

  it("finds a git revert of the merge commit, flags the card, and reflects on it", async () => {
    const m = mergedPr();
    g(m.repo, "revert", "--no-edit", "-m", "1", m.mergeCommit);
    const { cfg, chief, state, notes } = setup(m.root, m.repo, { status: "served", servedAt: daysAgo(2), mergeCommit: m.mergeCommit }, "Served");
    await chief.watchReverts();

    expect(state.get(ID)!.revertedAt).toBeDefined();
    expect(readLedger(cfg.ledgerFile).find((e) => e.kind === "reverted")).toMatchObject({ id: ID });
    expect(readBoard(cfg.boardPath).lane("Served")!.cards[0]!.status).toMatch(/^↩️ reverted in `[0-9a-f]{8}` · \[PR !7\]/);
    expect(notes.at(-1)!.title).toBe("Reverted: Add thing");
    expect(reflectorCalls()[0]!.prompt).toContain("was merged and then REVERTED 2 day(s) later");

    await chief.watchReverts();
    expect(readLedger(cfg.ledgerFile).filter((e) => e.kind === "reverted")).toHaveLength(1);
  });

  it("recognises an Azure DevOps revert PR by title, and stops watching after two weeks", async () => {
    const m = mergedPr();
    commit(m.repo, "a.txt", "", "Merged PR 12: Revert 'Add thing'");
    const r = await findRevert({ path: m.repo } as never, "main", { title: "Add thing", since: daysAgo(1) });
    expect(r?.subject).toBe("Merged PR 12: Revert 'Add thing'");
    expect(await findRevert({ path: m.repo } as never, "main", { title: "Something else", since: daysAgo(1) })).toBeUndefined();

    const { state, chief } = setup(m.root, m.repo, { status: "served", servedAt: daysAgo(15) }, "Served");
    await chief.watchReverts();
    expect(state.get(ID)!.revertedAt).toBeUndefined();
  });
});

describe("stats", () => {
  it("counts corrections, reverts and proposed recipes", () => {
    const at = new Date().toISOString();
    const events: LedgerEvent[] = [
      { kind: "run", at, id: "a", repo: "demo", status: "pass", rounds: 1 },
      { kind: "served", at, id: "a", repo: "demo" },
      { kind: "served", at, id: "b", repo: "demo" },
      { kind: "corrected", at, id: "a", repo: "demo", files: 1, insertions: 2, deletions: 0 },
      { kind: "reverted", at, id: "b", repo: "demo", sha: "x" },
      { kind: "reflect", at, id: "a", repo: "demo", proposals: 2, dropped: 0 },
    ];
    const s = computeStats(events, { since: new Date(0) });
    expect(s).toMatchObject({ corrected: 1, reverted: 1, recipesProposed: 2, served: 2 });
    expect(formatStats(s, 4)).toMatch(/corrected by you\s+1\s+50% of served/);
  });
});
