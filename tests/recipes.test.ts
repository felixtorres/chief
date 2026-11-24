import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Board, readBoard, updateBoard } from "../src/board.js";
import { Chief } from "../src/chief.js";
import { appendLedger, readLedger } from "../src/ledger.js";
import type { Note } from "../src/notify.js";
import { workerTools } from "../src/pipeline.js";
import {
  addLearnedTool, addRuleLine, allowToolProblem, learnedTools, parseProposals, recipeTextFromTitle, recipesSection, RecipeStore, removeLearnedTool,
} from "../src/recipes.js";
import { StateStore } from "../src/state.js";
import { fakeCalls, makeConfig, makeRepo, resetFakeEnv, tmp } from "./helpers.js";

const DENIED = ["Bash(git push:*)", "Bash(git remote:*)", "Bash(az:*)", "Bash(curl:*)", "Bash(wget:*)", "WebFetch", "WebSearch"];

const proposal = (over: Record<string, unknown> = {}) => ({
  kind: "review-rule",
  text: "Integration tests must use the test DB fixture, never mock the repository layer",
  why: "Same finding twice on this card",
  evidence: ["chief-abc123: review round 1 finding"],
  dedupeKey: "no-mock-repository-layer",
  ...over,
});

const reply = (...proposals: Record<string, unknown>[]) => "```json\n" + JSON.stringify({ proposals }) + "\n```";

describe("allowToolProblem", () => {
  it("accepts narrow, project-local command prefixes", () => {
    for (const t of ["Bash(npm run e2e:*)", "Bash(make test:*)", "Bash(pnpm turbo run lint:*)", "Bash(node scripts/check.js:*)", "Bash(git status)"]) {
      expect(allowToolProblem(t, DENIED)).toBeUndefined();
    }
  });

  it("rejects anything that overlaps a denied tool, runs arbitrary code, or isn't a Bash prefix", () => {
    const cases: [string, RegExp][] = [
      ["Bash(git push origin:*)", /overlaps the denied Bash\(git push:\*\)/],
      ["Bash(curl https://example.com:*)", /overlaps the denied Bash\(curl/],
      ["Bash(az repos list:*)", /overlaps the denied Bash\(az/],
      ["Bash(git:*)", /too broad/],
      ["Bash(npm:*)", /too broad/],
      ["Bash(npm test && curl x:*)", /metacharacters/],
      ["Bash(echo $(id):*)", /metacharacters|only Bash/],
      ["Bash(echo `id`:*)", /metacharacters/],
      ["Bash(bash scripts/x.sh:*)", /arbitrary commands/],
      ["Bash(sudo make install:*)", /arbitrary commands/],
      ["Bash(node -e:*)", /inline code/],
      ["Bash(python3 -c:*)", /inline code/],
      ["WebFetch", /only Bash/],
      ["Bash", /only Bash/],
    ];
    for (const [tool, why] of cases) expect(allowToolProblem(tool, DENIED), tool).toMatch(why);
  });
});

describe("parseProposals", () => {
  it("keeps valid proposals (max 2) and says why the others were dropped", () => {
    const text = reply(
      proposal(),
      proposal({ kind: "nonsense", dedupeKey: "bad-kind" }),
      proposal({ evidence: [], dedupeKey: "no-evidence" }),
      proposal({ text: "x".repeat(201), dedupeKey: "too-long" }),
      proposal({ dedupeKey: "Not A Key!" }),
      proposal({ kind: "allow-tool", text: "Bash(curl evil.sh:*)", dedupeKey: "curl-it" }),
      proposal({ kind: "claude-rule", text: "Run migrations before the tests", dedupeKey: "migrate-first" }),
      proposal({ kind: "lint-card", text: "Add a lint rule banning jest.mock of repositories", dedupeKey: "third-one" }),
    );
    const { proposals, dropped } = parseProposals(text, DENIED);
    expect(proposals.map((p) => p.dedupeKey)).toEqual(["no-mock-repository-layer", "migrate-first"]);
    expect(dropped).toEqual([
      'unknown kind "nonsense"',
      "no evidence cited",
      "text longer than 200 characters",
      'bad dedupeKey "not a key!"',
      expect.stringMatching(/allow-tool Bash\(curl evil.sh:\*\): overlaps/),
      "over the limit of 2: third-one",
    ]);
  });

  it("reports a non-JSON reply, and accepts zero proposals", () => {
    expect(parseProposals("I think it went fine", DENIED).error).toMatch(/not JSON/);
    expect(parseProposals('{"proposals": []}', DENIED)).toEqual({ proposals: [], dropped: [] });
  });
});

describe("rule files", () => {
  it("creates the file, appends a section, or inserts into the existing section before the next heading", () => {
    expect(addRuleLine(undefined, "REVIEW.md", "No mocks")).toBe(
      "# Review guidelines\n\n## Chief recipes\n\n<!-- Rules Chief learned from its own runs. Each one was approved on the board. -->\n- No mocks\n",
    );
    expect(addRuleLine("# Repo\n\nBe nice.\n", "CLAUDE.md", "Run migrations first")).toMatch(/Be nice\.\n\n## Chief recipes\n\n<!--.*-->\n- Run migrations first\n$/);
    const existing = "# R\n\n## Chief recipes\n\n- One\n\n## Other\n\ntext\n";
    expect(addRuleLine(existing, "REVIEW.md", "Two")).toBe("# R\n\n## Chief recipes\n\n- One\n- Two\n\n## Other\n\ntext\n");
    expect(addRuleLine("# R\n\n## Chief recipes\n", "REVIEW.md", "First")).toBe("# R\n\n## Chief recipes\n\n- First\n");
    expect(addRuleLine(existing, "REVIEW.md", "One")).toBeUndefined();
    expect(recipesSection(existing)).toBe("- One");
  });

  it("reads the rule text back from an edited recipe card title", () => {
    expect(recipeTextFromTitle("📖 REVIEW.md: Never mock the repository layer")).toBe("Never mock the repository layer");
    expect(recipeTextFromTitle("📖 allow: Bash(npm run e2e:*)")).toBe("Bash(npm run e2e:*)");
  });
});

describe("learned.json", () => {
  it("adds, lists (re-vetted) and removes learned tools per repo, and workers get them", () => {
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = makeConfig(root, repo);
    addLearnedTool(cfg.learnedFile, "demo", { tool: "Bash(npm run e2e:*)", recipe: "r-000001", at: "t", evidence: [] });
    addLearnedTool(cfg.learnedFile, "demo", { tool: "Bash(npm run e2e:*)", recipe: "r-000001", at: "t", evidence: [] });
    // Someone hand-edits a dangerous entry into the file: it is ignored.
    const file = JSON.parse(readFileSync(cfg.learnedFile, "utf8"));
    file.allowedTools.demo.push({ tool: "Bash(curl:*)", recipe: "r-evil00", at: "t", evidence: [] });
    writeFileSync(cfg.learnedFile, JSON.stringify(file));
    expect(learnedTools(cfg.learnedFile, "demo", cfg.disallowedTools)).toEqual(["Bash(npm run e2e:*)"]);
    expect(workerTools(cfg, cfg.repos.demo!)).toContain("Bash(npm run e2e:*)");
    expect(workerTools(cfg, cfg.repos.demo!)).not.toContain("Bash(curl:*)");
    expect(removeLearnedTool(cfg.learnedFile, "r-000001")).toBe(true);
    expect(learnedTools(cfg.learnedFile, "demo", cfg.disallowedTools)).toEqual([]);
  });
});

// ---------------------------------------------------------------- the loop, end to end

const STARTER = readFileSync(new URL("../templates/board.example.md", import.meta.url), "utf8");

function boardWith(lanes: Record<string, string[]>, starter = STARTER): string {
  const b = Board.parse(starter);
  for (const lane of b.lanes) lane.cards = [];
  let text = b.render();
  for (const [lane, cards] of Object.entries(lanes)) {
    text = text.replace(`## ${lane}\n\n`, `## ${lane}\n\n${cards.map((c) => `- [ ] ${c}`).join("\n")}\n`);
  }
  return Board.parse(text).render();
}

function setup(lanes: Record<string, string[]>, overrides: Record<string, unknown> = {}, starter = STARTER) {
  const root = tmp();
  const repo = makeRepo(root);
  const cfg = makeConfig(root, repo, overrides);
  writeFileSync(cfg.boardPath, boardWith(lanes, starter));
  const state = new StateStore(cfg.stateFile);
  const notes: Note[] = [];
  const chief = new Chief(cfg, state, () => {}, async (_c, n) => notes.push(n));
  return { root, repo, cfg, state, chief, notes };
}

const reflectorCalls = () => fakeCalls().filter((c) => c.prompt.includes("RECIPE KEEPER"));
const recipeCards = (path: string) => readBoard(path).lane("Recipes")?.cards ?? [];

/** Cook one card that needs two rounds (review asks for changes once), so it's worth reflecting on. */
async function bumpyRun(lanes: Record<string, string[]> = { Ready: ["Add feature file"] }, overrides: Record<string, unknown> = {}, starter = STARTER) {
  process.env.FAKE_REVIEW = "changes,approve";
  const s = setup(lanes, overrides, starter);
  await s.chief.tick();
  return s;
}

function moveRecipe(path: string, recipeId: string, lane: string, edit?: (text: string) => string): void {
  updateBoard(path, (board) => {
    for (const l of board.lanes) {
      const card = l.cards.find((c) => c.recipe === recipeId);
      if (!card) continue;
      if (edit) card.text = edit(card.text);
      board.move(card, lane);
      return;
    }
    throw new Error(`no card for ${recipeId}`);
  });
}

beforeEach(resetFakeEnv);

describe("reflector", () => {
  it("proposes a recipe after a bumpy run: card in the Recipes lane, stored, logged, notified", async () => {
    process.env.FAKE_REFLECT = reply(proposal());
    const { cfg, chief, notes, repo } = await bumpyRun();

    const calls = reflectorCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("RUN LOG:\n# Chief run: Add feature file");
    expect(calls[0]!.prompt).toContain("passed after 2 rounds");
    expect(calls[0]!.cwd).toContain("worktrees");
    const args = calls[0]!.args;
    expect(args.slice(args.indexOf("--disallowedTools"))).toEqual(expect.arrayContaining(["Edit", "Write"]));
    expect(repo).toBeTruthy();

    const [r] = chief.recipes.all();
    expect(r).toMatchObject({ kind: "review-rule", status: "proposed", repo: "demo", dedupeKey: "no-mock-repository-layer" });
    const card = recipeCards(cfg.boardPath)[0]!;
    expect(card.title).toBe(`📖 REVIEW.md: ${proposal().text} #repo/demo #recipe/${r!.id}`);
    expect(card.notes).toEqual([
      "why: Same finding twice on this card",
      "evidence: chief-abc123: review round 1 finding",
      "Move to Ready to apply · check it off or delete it to reject",
    ]);
    expect(readLedger(cfg.ledgerFile).find((e) => e.kind === "reflect")).toMatchObject({ proposals: 1, dropped: 0 });
    expect(notes.at(-1)!.title).toBe("1 recipe proposed for demo");
  });

  it("costs nothing on a clean one-round pass", async () => {
    process.env.FAKE_REFLECT = reply(proposal());
    const { chief } = setup({ Ready: ["Add feature file"] });
    await chief.tick();
    expect(reflectorCalls()).toHaveLength(0);
    expect(chief.recipes.all()).toEqual([]);
  });

  it("respects the daily cap and the off switch", async () => {
    const capped = setup({ Ready: ["Add feature file"] }, { reflectorDailyCap: 1 });
    appendLedger(capped.cfg.ledgerFile, { kind: "reflect", at: new Date().toISOString(), id: "x", repo: "demo", proposals: 0, dropped: 0 });
    process.env.FAKE_REVIEW = "changes,approve";
    await capped.chief.tick();
    expect(reflectorCalls()).toHaveLength(0);

    await bumpyRun(undefined, { reflector: false });
    expect(reflectorCalls()).toHaveLength(0);
  });

  it("never re-proposes a known rule, and drops dangerous allow-tool proposals before the board", async () => {
    process.env.FAKE_REFLECT = reply(proposal(), proposal({ kind: "allow-tool", text: "Bash(git push --force:*)", dedupeKey: "force-push" }));
    const root = tmp();
    const repo = makeRepo(root);
    const cfg = makeConfig(root, repo);
    new RecipeStore(cfg.recipesFile).add({
      id: "r-aaaaaa", kind: "review-rule", repo: "demo", text: "old", why: "", evidence: ["x"], dedupeKey: "no-mock-repository-layer", fromCard: "zzzzzz", status: "rejected",
    });
    writeFileSync(cfg.boardPath, boardWith({ Ready: ["Add feature file"] }));
    process.env.FAKE_REVIEW = "changes,approve";
    const chief = new Chief(cfg, new StateStore(cfg.stateFile), () => {}, async () => {});
    await chief.tick();
    expect(chief.recipes.all().map((r) => r.id)).toEqual(["r-aaaaaa"]);
    expect(recipeCards(cfg.boardPath)).toHaveLength(0);
    expect(readLedger(cfg.ledgerFile).find((e) => e.kind === "reflect")).toMatchObject({ proposals: 0, dropped: 2 });
    expect(reflectorCalls()[0]!.prompt).toContain("- [rejected] no-mock-repository-layer: REVIEW.md: old");
  });

  it("adds the Recipes lane to a board that doesn't have one", async () => {
    process.env.FAKE_REFLECT = reply(proposal());
    const noRecipes = STARTER.replace("## Recipes\n\n\n\n", "");
    expect(Board.parse(noRecipes).lane("Recipes")).toBeUndefined();
    const { cfg } = await bumpyRun(undefined, {}, noRecipes);
    expect(recipeCards(cfg.boardPath)).toHaveLength(1);
  });
});

describe("approving and rejecting recipes", () => {
  it("applies an approved review rule as a one-line commit, using the text as you edited it", async () => {
    process.env.FAKE_REFLECT = reply(proposal());
    const { cfg, chief, repo, notes } = await bumpyRun();
    const r = chief.recipes.all()[0]!;
    moveRecipe(cfg.boardPath, r.id, "Ready", (t) => t.replace("never mock the repository layer", "never mock repositories"));

    expect(await chief.tick()).toBe(true);
    const applied = chief.recipes.get(r.id)!;
    expect(applied).toMatchObject({ status: "applied", text: "Integration tests must use the test DB fixture, never mock repositories" });
    const card = readBoard(cfg.boardPath).lane("Pass")!.cards.find((c) => c.recipe === r.id)!;
    expect(card.status).toMatch(/^🔍 📖 REVIEW\.md rule · branch `chief\/[0-9a-f]{6}-recipe-review-md` · merge to apply$/);
    expect(applied.cardId).toBe(card.id);

    const branch = /`(chief\/[^`]+)`/.exec(card.status)![1]!;
    const review = execFileSync("git", ["show", `${branch}:REVIEW.md`], { cwd: repo }).toString();
    expect(review).toContain("## Chief recipes");
    expect(review).toContain("- Integration tests must use the test DB fixture, never mock repositories\n");
    expect(execFileSync("git", ["log", "-1", "--format=%s", branch], { cwd: repo }).toString()).toContain(`recipe ${r.id}`);
    expect(notes.at(-1)!.title).toBe("Recipe ready: REVIEW.md rule");
    // Applying a recipe is not a cooking run: no worker, no reflector.
    expect(fakeCalls().filter((c) => !c.prompt.includes("RECIPE KEEPER") && !c.prompt.includes("REVIEWER"))).toHaveLength(2);
  });

  it("rejects a recipe you check off or delete, and never proposes it again", async () => {
    process.env.FAKE_REFLECT = reply(proposal(), proposal({ kind: "claude-rule", text: "Run migrations first", dedupeKey: "migrate-first" }));
    const { cfg, chief } = await bumpyRun();
    const [a, b] = chief.recipes.all().sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey));
    updateBoard(cfg.boardPath, (board) => {
      const lane = board.lane("Recipes")!;
      lane.cards.find((c) => c.recipe === a!.id)!.checked = true;
      lane.cards = lane.cards.filter((c) => c.recipe !== b!.id);
    });
    expect(chief.syncRecipes().map((r) => r.reason).sort()).toEqual(["card deleted from the board", "checked off on the board"]);
    expect(chief.recipes.get(a!.id)!.status).toBe("rejected");
    expect(chief.recipes.has("demo", "migrate-first")).toBe(true);
  });

  it("learns an approved allow-tool locally, so the next worker may run it, and can undo it", async () => {
    process.env.FAKE_DENY = "npm run e2e";
    process.env.FAKE_REFLECT = reply(proposal({ kind: "allow-tool", text: "Bash(npm run e2e:*)", dedupeKey: "allow-e2e" }));
    const { cfg, chief } = await bumpyRun();
    const r = chief.recipes.all()[0]!;
    moveRecipe(cfg.boardPath, r.id, "Ready");
    await chief.tick();

    expect(chief.recipes.get(r.id)!.status).toBe("applied");
    expect(learnedTools(cfg.learnedFile, "demo", cfg.disallowedTools)).toEqual(["Bash(npm run e2e:*)"]);
    const card = readBoard(cfg.boardPath).lane("Served")!.cards.find((c) => c.recipe === r.id)!;
    expect(card.status).toBe(`✅ learned for demo · undo: chief recipes revert ${r.id}`);

    delete process.env.FAKE_DENY;
    delete process.env.FAKE_REVIEW;
    updateBoard(cfg.boardPath, (board) => board.lane("Ready")!.cards.push(Board.parse("## x\n- [ ] Next card\n").lanes[0]!.cards[0]!));
    await chief.tick();
    const worker = fakeCalls().filter((c) => c.prompt.includes("CARD: Next card"))[0]!;
    expect(worker.args).toContain("Bash(npm run e2e:*)");
  });

  it("refuses an allow-tool you edited into something dangerous", async () => {
    process.env.FAKE_DENY = "npm run e2e";
    process.env.FAKE_REFLECT = reply(proposal({ kind: "allow-tool", text: "Bash(npm run e2e:*)", dedupeKey: "allow-e2e" }));
    const { cfg, chief } = await bumpyRun();
    const r = chief.recipes.all()[0]!;
    moveRecipe(cfg.boardPath, r.id, "Ready", (t) => t.replace("Bash(npm run e2e:*)", "Bash(curl:*)"));
    await chief.tick();
    expect(chief.recipes.get(r.id)!.status).toBe("failed");
    expect(learnedTools(cfg.learnedFile, "demo", cfg.disallowedTools)).toEqual([]);
    expect(readBoard(cfg.boardPath).lane("Blocked")!.cards.find((c) => c.recipe === r.id)!.status).toMatch(/not applied: overlaps the denied/);
  });

  it("cooks an approved lint-card recipe as a normal card, without reflecting on it", async () => {
    process.env.FAKE_REFLECT = reply(proposal({ kind: "lint-card", text: "Add a lint rule banning mocks of repositories", dedupeKey: "lint-no-mocks" }));
    const { cfg, chief } = await bumpyRun();
    const r = chief.recipes.all()[0]!;
    moveRecipe(cfg.boardPath, r.id, "Ready");
    process.env.FAKE_REVIEW = "changes,approve";
    const before = reflectorCalls().length;
    await chief.tick();

    const worker = fakeCalls().filter((c) => c.prompt.includes("CARD: Add a lint rule banning mocks of repositories"))[0]!;
    expect(worker.prompt).toContain(`Recipe ${r.id}: enforce this rule with an automated check`);
    expect(chief.recipes.get(r.id)!.status).toBe("applied");
    expect(reflectorCalls()).toHaveLength(before);
  });

  it("uses a conventional commit message, and a failed recipe can be retried", async () => {
    const { chmodSync, mkdirSync, rmSync } = await import("node:fs");
    process.env.FAKE_REFLECT = reply(proposal());
    const { cfg, chief, repo } = await bumpyRun();
    const r = chief.recipes.all()[0]!;
    // A commit-msg hook like nex-ts's commitlint: first it rejects everything, then only scoped messages pass.
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    const hook = join(repo, ".git", "hooks", "commit-msg");
    writeFileSync(hook, '#!/bin/sh\necho "✖ scope may not be empty [scope-empty]"; exit 1\n');
    chmodSync(hook, 0o755);
    moveRecipe(cfg.boardPath, r.id, "Ready");
    await chief.tick();
    expect(chief.recipes.get(r.id)!.status).toBe("failed");
    const blockedCard = readBoard(cfg.boardPath).lane("Blocked")!.cards.find((c) => c.recipe === r.id)!;
    expect(blockedCard.status).toContain("scope may not be empty");

    writeFileSync(hook, '#!/bin/sh\ngrep -qE "^[a-z]+\\([a-z-]+\\): " "$1" || { echo "✖ scope may not be empty"; exit 1; }\n');
    moveRecipe(cfg.boardPath, r.id, "Ready");
    await chief.tick();
    expect(chief.recipes.get(r.id)!.status).toBe("applied");
    const card = readBoard(cfg.boardPath).lane("Pass")!.cards.find((c) => c.recipe === r.id)!;
    const branch = /`(chief\/[^`]+)`/.exec(card.status)![1]!;
    expect(execFileSync("git", ["log", "-1", "--format=%s", branch], { cwd: repo }).toString()).toMatch(/^docs\(repo\): add REVIEW\.md rule from Chief recipe r-/);
    expect(execFileSync("git", ["rev-list", "--count", `main..${branch}`], { cwd: repo }).toString().trim()).toBe("1");
    rmSync(hook);
  });

  it("commits without hooks only when a hook could not run, and still blocks on a hook that refused", async () => {
    const { chmodSync, mkdirSync, rmSync } = await import("node:fs");
    process.env.FAKE_REFLECT = reply(proposal());
    const { cfg, chief, repo } = await bumpyRun();
    const r = chief.recipes.all()[0]!;
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    const hook = join(repo, ".git", "hooks", "pre-commit");
    // A hook that ran and said no: the recipe stays blocked, no --no-verify.
    writeFileSync(hook, '#!/bin/sh\necho "✖ check-kits: kit drift"; exit 1\n');
    chmodSync(hook, 0o755);
    moveRecipe(cfg.boardPath, r.id, "Ready");
    await chief.tick();
    expect(chief.recipes.get(r.id)!.status).toBe("failed");
    expect(readBoard(cfg.boardPath).lane("Blocked")!.cards.find((c) => c.recipe === r.id)!.status).toContain("kit drift");

    // Like nex-ts in a recipe worktree: the hook's tool isn't installed, so the hook cannot run.
    writeFileSync(hook, "#!/bin/sh\n./node_modules/.bin/turbo run typecheck\n");
    moveRecipe(cfg.boardPath, r.id, "Ready");
    await chief.tick();
    expect(chief.recipes.get(r.id)!.status).toBe("applied");
    const card = readBoard(cfg.boardPath).lane("Pass")!.cards.find((c) => c.recipe === r.id)!;
    const branch = /`(chief\/[^`]+)`/.exec(card.status)![1]!;
    expect(execFileSync("git", ["log", "-1", "--format=%s", branch], { cwd: repo }).toString()).toMatch(/^docs\(repo\): add REVIEW\.md rule/);
    expect(execFileSync("git", ["rev-list", "--count", `main..${branch}`], { cwd: repo }).toString().trim()).toBe("1");
    rmSync(hook);
  });

  it("tells a hook that could not run from one that refused", async () => {
    const { hookCouldNotRun } = await import("../src/pipeline.js");
    expect(hookCouldNotRun("sh: ./node_modules/.bin/turbo: No such file or directory\nexit status 127")).toBe(true);
    expect(hookCouldNotRun("lefthook: biome: command not found")).toBe(true);
    expect(hookCouldNotRun("✖ scope may not be empty [scope-empty]")).toBe(false);
    expect(hookCouldNotRun("✖ check-kits: kit drift")).toBe(false);
  });

  it("won't apply a recipe card twice", async () => {
    process.env.FAKE_REFLECT = reply(proposal());
    const { cfg, chief } = await bumpyRun();
    const r = chief.recipes.all()[0]!;
    chief.recipes.update(r.id, { status: "rejected" });
    moveRecipe(cfg.boardPath, r.id, "Ready");
    await chief.tick();
    expect(readBoard(cfg.boardPath).lane("Blocked")!.cards.find((c) => c.recipe === r.id)!.status).toContain(`recipe ${r.id} is already rejected`);
  });
});

describe("recipe store", () => {
  it("persists across instances and finds recipes by card", () => {
    const file = join(tmp(), "recipes.json");
    const a = new RecipeStore(file);
    a.add({ id: "r-111111", kind: "claude-rule", repo: "demo", text: "t", why: "", evidence: ["e"], dedupeKey: "k-one", fromCard: "aaaaaa" });
    a.update("r-111111", { cardId: "bbbbbb", status: "applied" });
    const b = new RecipeStore(file);
    expect(b.byCard("bbbbbb")!.status).toBe("applied");
    expect(b.has("demo", "k-one")).toBe(true);
    expect(b.has("other", "k-one")).toBe(false);
  });
});
