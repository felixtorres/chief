import { existsSync } from "node:fs";
import { prStatus } from "./ado.js";
import { Card, Lane, laneKey, readBoard, updateBoard } from "./board.js";
import type { Config, RepoConfig } from "./config.js";
import { appendLedger, categorize, readLedger, reflectionsOn } from "./ledger.js";
import { notify, writeWeeklyStats, type Note } from "./notify.js";
import { applyRule, cook, removeWorktree, type Log, type Outcome } from "./pipeline.js";
import {
  addLearnedTool, allowToolProblem, KIND_LABEL, newRecipeId, RecipeStore, recipeCardNotes, recipeCardText, recipeTextFromTitle, RULE_FILE,
  type Recipe,
} from "./recipes.js";
import { isInteresting, reflect } from "./reflect.js";
import type { Blast, StateStore } from "./state.js";

export interface Claimed {
  id: string;
  title: string;
  notes: string[];
  repo?: RepoConfig;
  /** Branch to start from and target; undefined means the repo's default branch. */
  base?: string;
  problem?: string;
  /** Set when the card is an approved recipe (#recipe/r-xxxxxx). */
  recipe?: string;
}

export type Notifier = (cfg: Config, note: Note) => Promise<unknown>;

const BLAST_ICON: Record<Blast, string> = { green: "🟢", yellow: "🟡", red: "🔴" };
const SERVED_CHECK_MS = 10 * 60_000;

function hhmm(d = new Date()): string {
  return d.toTimeString().slice(0, 5);
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Obsidian link from a card to its run log (src/trace.ts writes runsDir/chief-<id>.md). */
export function logLink(id: string): string {
  return `[[chief-${id}|run log]]`;
}

export function passStatus(o: Outcome, id: string): string {
  const blast = o.blast ? `${BLAST_ICON[o.blast]} ${o.blast}` : "";
  const where = o.prUrl ? `[PR !${o.prId}](${o.prUrl})` : `branch \`${o.branch}\``;
  const parts = [`🔍 ${blast}`.trim(), where, `${o.rounds} round${o.rounds === 1 ? "" : "s"}`];
  if (o.runLog) parts.push(logLink(id));
  return parts.join(" · ");
}

export class Chief {
  private lastServedCheck = 0;
  private stopping = false;
  private recipeStore?: RecipeStore;

  constructor(
    private cfg: Config,
    private state: StateStore,
    private log: Log = (m) => console.log(`${new Date().toISOString()} ${m}`),
    private send: Notifier = notify,
  ) {}

  stop(): void {
    this.stopping = true;
  }

  get recipes(): RecipeStore {
    this.recipeStore ??= new RecipeStore(this.cfg.recipesFile);
    return this.recipeStore;
  }

  /** Cards left in Cooking by a crash or restart go to Blocked; nothing is silently resumed. */
  recover(): number {
    const stale = this.state.byStatus("cooking");
    for (const run of stale) {
      const reason = "interrupted: Chief restarted mid-run (worktree kept)";
      this.state.upsert({ id: run.id, status: "blocked", reason });
      appendLedger(this.cfg.ledgerFile, {
        kind: "run", at: new Date().toISOString(), id: run.id, repo: run.repo, status: "blocked", rounds: run.rounds, category: "interrupted",
      });
      this.moveCard(run.id, this.cfg.lanes.blocked, `🚧 ${reason}`);
    }
    if (stale.length) this.log(`recovered ${stale.length} interrupted card(s) → Blocked`);
    return stale.length;
  }

  private moveCard(id: string, lane: string, status: string): void {
    updateBoard(this.cfg.boardPath, (board) => {
      const found = board.findById(id);
      if (!found) return;
      found.card.setStatus(status);
      if (found.lane !== board.lane(lane)) board.move(found.card, lane);
    });
  }

  /**
   * Take the first card in Ready (or a specific card by id / title text from Backlog or
   * Ready), tag it, and move it to Cooking. Cards outside those lanes are never touched.
   */
  claim(selector?: string): Claimed | undefined {
    const { lanes } = this.cfg;
    return updateBoard(this.cfg.boardPath, (board) => {
      for (const name of [lanes.ready, lanes.cooking, lanes.pass, lanes.blocked]) {
        if (!board.lane(name)) throw new Error(`board is missing the "${name}" lane`);
      }
      let card: Card | undefined;
      if (selector) {
        const needle = selector.toLowerCase();
        card = [board.lane(lanes.ready), board.lane(lanes.backlog)]
          .flatMap((l) => l?.cards ?? [])
          .find((c) => c.id === selector || c.cleanTitle.toLowerCase().includes(needle));
      } else {
        card = board.lane(lanes.ready)?.cards.find((c) => !c.checked);
      }
      if (!card) return undefined;

      const id = card.ensureId();
      const repoName = card.repo ?? this.cfg.defaultRepo;
      const repo = repoName ? this.cfg.repos[repoName] : undefined;
      const claimed: Claimed = { id, title: card.cleanTitle, notes: card.notes, repo, recipe: card.recipe };
      const base = this.resolveBase(card.base, id);
      claimed.base = base.branch;
      const recipe = card.recipe ? this.recipes.get(card.recipe) : undefined;
      const recipeProblem = !card.recipe
        ? undefined
        : !recipe
          ? `unknown recipe ${card.recipe}`
          : recipe.status !== "proposed"
            ? `recipe ${card.recipe} is already ${recipe.status}`
            : undefined;
      if (!repo || base.problem || recipeProblem) {
        claimed.problem = recipeProblem ?? base.problem
          ?? (repoName ? `unknown repo "${repoName}"; add it to the Chief config` : "no repo: tag the card with #repo/<name>");
        card.setStatus(`🚧 ${claimed.problem}`);
        board.move(card, lanes.blocked);
      } else {
        card.setStatus(card.recipe ? `🍳 applying recipe since ${hhmm()}` : `🍳 cooking since ${hhmm()} · ${logLink(id)}`);
        board.move(card, lanes.cooking);
      }
      return claimed;
    });
  }

  /** #base/chief-<id> means "on top of that card's branch"; anything else is a branch name. */
  private resolveBase(tag: string | undefined, self: string): { branch?: string; problem?: string } {
    if (!tag) return {};
    const ref = /^chief-([0-9a-f]{6})$/.exec(tag);
    if (!ref) return { branch: tag };
    if (ref[1] === self) return { problem: "#base/ points at this card itself" };
    const branch = this.state.get(ref[1]!)?.branch;
    return branch ? { branch } : { problem: `#base/${tag}: Chief has no branch for card #chief-${ref[1]} yet` };
  }

  async cookCard(c: Claimed): Promise<Outcome | undefined> {
    if (!c.repo || c.problem) {
      this.state.upsert({ id: c.id, title: c.title, repo: c.repo?.name ?? "", status: "blocked", reason: c.problem });
      await this.send(this.cfg, { title: `Blocked: ${c.title}`, body: c.problem ?? "" });
      return undefined;
    }
    const repo = c.repo;
    if (c.recipe) {
      const r = this.recipes.get(c.recipe)!;
      const text = recipeTextFromTitle(c.title);
      if (r.kind === "allow-tool") return this.applyAllowTool(c, repo, r, text);
      if (r.kind !== "lint-card") return this.applyRuleRecipe(c, repo, r, text);
      // A lint-card recipe is a normal card: the worker adds the automated check.
      this.recipes.update(r.id, { status: "applying", cardId: c.id, text });
      c = {
        ...c,
        title: text,
        notes: [
          `Recipe ${r.id}: enforce this rule with an automated check in the codebase (a lint rule, test, or script), not with prose.`,
          `Why: ${r.why || "(none given)"}`,
          `Evidence: ${r.evidence.join("; ")}`,
        ],
      };
    }
    this.state.upsert({ id: c.id, title: c.title, repo: repo.name, status: "cooking", rounds: 0, reason: undefined });
    this.log(`[${c.id}] cooking "${c.title}" in ${repo.name}`);

    let outcome: Outcome;
    try {
      outcome = await cook(this.cfg, { id: c.id, title: c.title, notes: c.notes, repo, base: c.base }, this.log);
    } catch (err) {
      outcome = { status: "blocked", reason: `Chief error: ${(err as Error).message}`, summary: "", rounds: 0, branch: "", worktree: "" };
    }
    appendLedger(this.cfg.ledgerFile, {
      kind: "run",
      at: new Date().toISOString(),
      id: c.id,
      repo: repo.name,
      status: outcome.status,
      rounds: outcome.rounds,
      blast: outcome.blast,
      category: outcome.status === "blocked" ? (outcome.category ?? categorize(outcome.reason)) : undefined,
      ruleFiles: outcome.ruleFiles?.length ? outcome.ruleFiles : undefined,
      ...outcome.metrics,
    });

    this.state.upsert({
      id: c.id,
      status: outcome.status,
      branch: outcome.branch || undefined,
      worktree: outcome.worktree || undefined,
      prId: outcome.prId,
      prUrl: outcome.prUrl,
      rounds: outcome.rounds,
      blast: outcome.blast,
      reason: outcome.reason,
      summary: outcome.summary,
    });

    if (outcome.status === "pass") {
      this.moveCard(c.id, this.cfg.lanes.pass, passStatus(outcome, c.id));
      await this.send(this.cfg, {
        title: `Ready at the pass: ${c.title}`,
        body: `${outcome.blast ?? "?"} blast radius, ${outcome.rounds} round(s). ${outcome.prUrl ? "Draft PR opened." : `Branch ${outcome.branch}.`}`,
        url: outcome.prUrl,
      });
    } else {
      this.moveCard(c.id, this.cfg.lanes.blocked, `🚧 ${oneLine(outcome.reason ?? "blocked")}${outcome.runLog ? ` · ${logLink(c.id)}` : ""}`);
      await this.send(this.cfg, { title: `Blocked: ${c.title}`, body: oneLine(outcome.reason ?? "blocked", 400) });
    }
    this.log(`[${c.id}] → ${outcome.status}${outcome.reason ? `: ${oneLine(outcome.reason)}` : ""}`);
    if (c.recipe) {
      this.recipes.update(c.recipe, outcome.status === "pass"
        ? { status: "applied", prId: outcome.prId, prUrl: outcome.prUrl }
        : { status: "failed", reason: outcome.reason });
    } else {
      await this.maybeReflect(c, repo, outcome);
    }
    return outcome;
  }

  /** Approved allow-tool recipe: add it to the local learned.json overlay. No PR, no worker. */
  private async applyAllowTool(c: Claimed, repo: RepoConfig, r: Recipe, tool: string): Promise<undefined> {
    const problem = allowToolProblem(tool, this.cfg.disallowedTools);
    if (problem) {
      this.recipes.update(r.id, { status: "failed", cardId: c.id, reason: problem });
      this.state.upsert({ id: c.id, title: c.title, repo: repo.name, status: "blocked", rounds: 0, reason: problem });
      this.moveCard(c.id, this.cfg.lanes.blocked, `🚧 not applied: ${problem}`);
      await this.send(this.cfg, { title: `Recipe not applied: ${tool}`, body: problem });
      return undefined;
    }
    addLearnedTool(this.cfg.learnedFile, repo.name, { tool, recipe: r.id, at: new Date().toISOString(), evidence: r.evidence });
    this.recipes.update(r.id, { status: "applied", cardId: c.id, text: tool });
    this.state.upsert({ id: c.id, title: c.title, repo: repo.name, status: "served", rounds: 0, reason: undefined });
    this.moveCard(c.id, this.cfg.lanes.served, `✅ learned for ${repo.name} · undo: chief recipes revert ${r.id}`);
    this.log(`[${c.id}] recipe ${r.id}: workers in ${repo.name} may now run ${tool}`);
    await this.send(this.cfg, { title: `Recipe applied: ${tool}`, body: `Workers in ${repo.name} may now run it. Undo with chief recipes revert ${r.id}.` });
    return undefined;
  }

  /** Approved review-rule / claude-rule recipe: one-line draft PR to the repo. */
  private async applyRuleRecipe(c: Claimed, repo: RepoConfig, r: Recipe, text: string): Promise<Outcome> {
    const file = RULE_FILE[r.kind]!;
    this.recipes.update(r.id, { status: "applying", cardId: c.id, text });
    this.state.upsert({ id: c.id, title: c.title, repo: repo.name, status: "cooking", rounds: 0, reason: undefined });
    let outcome: Outcome;
    try {
      outcome = await applyRule(this.cfg, { id: c.id, recipeId: r.id, repo, file, text, why: r.why, evidence: r.evidence }, this.log);
    } catch (err) {
      outcome = { status: "blocked", reason: `Chief error: ${(err as Error).message}`, summary: "", rounds: 0, branch: "", worktree: "" };
    }
    this.state.upsert({
      id: c.id, status: outcome.status, branch: outcome.branch || undefined, worktree: outcome.worktree || undefined,
      prId: outcome.prId, prUrl: outcome.prUrl, rounds: 0, reason: outcome.reason, summary: outcome.summary,
    });
    if (outcome.status === "pass") {
      this.recipes.update(r.id, { status: "applied", prId: outcome.prId, prUrl: outcome.prUrl });
      const where = outcome.prUrl ? `[PR !${outcome.prId}](${outcome.prUrl})` : `branch \`${outcome.branch}\``;
      this.moveCard(c.id, this.cfg.lanes.pass, `🔍 📖 ${file} rule · ${where} · merge to apply`);
      await this.send(this.cfg, { title: `Recipe ready: ${file} rule`, body: text, url: outcome.prUrl });
    } else {
      this.recipes.update(r.id, { status: "failed", reason: outcome.reason });
      this.moveCard(c.id, this.cfg.lanes.blocked, `🚧 ${oneLine(outcome.reason ?? "recipe failed")}`);
      await this.send(this.cfg, { title: `Recipe failed: ${file} rule`, body: oneLine(outcome.reason ?? "", 400) });
    }
    this.log(`[${c.id}] recipe ${r.id} → ${outcome.status}`);
    return outcome;
  }

  /** After a run that went wrong: ask the reflector for recipes and put them on the board. */
  private async maybeReflect(c: Claimed, repo: RepoConfig, outcome: Outcome): Promise<Recipe[]> {
    if (!this.cfg.reflector || !isInteresting(outcome)) return [];
    if (reflectionsOn(readLedger(this.cfg.ledgerFile)) >= this.cfg.reflectorDailyCap) {
      this.log(`[${c.id}] reflector skipped: daily cap of ${this.cfg.reflectorDailyCap} reached`);
      return [];
    }
    try {
      this.log(`[${c.id}] reflecting on the run`);
      const res = await reflect(this.cfg, { id: c.id, title: c.title, repo }, outcome, this.recipes.byRepo(repo.name));
      const fresh = res.proposals.filter((p) => !this.recipes.has(repo.name, p.dedupeKey));
      const dropped = [...res.dropped, ...res.proposals.filter((p) => !fresh.includes(p)).map((p) => `already known: ${p.dedupeKey}`)];
      appendLedger(this.cfg.ledgerFile, {
        kind: "reflect", at: new Date().toISOString(), id: c.id, repo: repo.name, proposals: fresh.length, dropped: dropped.length, error: res.error,
      });
      if (res.error) this.log(`[${c.id}] ${res.error}`);
      if (dropped.length) this.log(`[${c.id}] reflector proposals dropped: ${dropped.join("; ")}`);
      if (!fresh.length) return [];

      const drafts = fresh.map((p) => ({ ...p, id: newRecipeId(), repo: repo.name, fromCard: c.id }));
      // Card first, then the store: a stored recipe with no card would read as "rejected".
      updateBoard(this.cfg.boardPath, (board) => {
        let lane = board.lane(this.cfg.lanes.recipes);
        if (!lane) {
          lane = new Lane(this.cfg.lanes.recipes);
          board.lanes.push(lane);
        }
        for (const d of drafts) lane.cards.push(new Card(false, recipeCardText(d), recipeCardNotes(d)));
      });
      const added = drafts.map((d) => this.recipes.add(d));
      this.log(`[${c.id}] proposed ${added.length} recipe(s): ${added.map((r) => r.id).join(", ")}`);
      await this.send(this.cfg, {
        title: `${added.length} recipe${added.length === 1 ? "" : "s"} proposed for ${repo.name}`,
        body: added.map((r) => `${KIND_LABEL[r.kind]}: ${r.text}`).join(" · "),
      });
      return added;
    } catch (err) {
      this.log(`[${c.id}] reflector failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Proposed recipes whose card you checked off in the Recipes lane, or deleted, are rejected.
   * The record stays as a tombstone so the same rule is never proposed again.
   */
  syncRecipes(): Recipe[] {
    const open = this.recipes.all().filter((r) => r.status === "proposed");
    if (!open.length || !existsSync(this.cfg.boardPath)) return [];
    const board = readBoard(this.cfg.boardPath);
    const where = new Map<string, { lane: Lane; card: Card }>();
    for (const lane of board.lanes) for (const card of lane.cards) if (card.recipe) where.set(card.recipe, { lane, card });
    const rejected: Recipe[] = [];
    for (const r of open) {
      const found = where.get(r.id);
      const checkedOff = found?.card.checked && laneKey(found.lane.name) === laneKey(this.cfg.lanes.recipes);
      if (found && !checkedOff) continue;
      const reason = found ? "checked off on the board" : "card deleted from the board";
      const updated = this.recipes.update(r.id, { status: "rejected", reason });
      if (updated) rejected.push(updated);
      this.log(`recipe ${r.id} rejected (${reason})`);
    }
    return rejected;
  }

  /** Move cards whose PR was completed in Azure DevOps to Served. Rate-limited. */
  async checkServed(force = false): Promise<void> {
    if (!this.cfg.openPr) return;
    if (!force && Date.now() - this.lastServedCheck < SERVED_CHECK_MS) return;
    this.lastServedCheck = Date.now();
    for (const run of this.state.byStatus("served")) if (run.worktree) await this.cleanUp(run.id);
    for (const run of this.state.byStatus("pass")) {
      const repo = this.cfg.repos[run.repo];
      if (!run.prId || !repo) continue;
      const status = await prStatus(this.cfg, repo, run.prId);
      if (status === "completed") {
        this.state.upsert({ id: run.id, status: "served" });
        appendLedger(this.cfg.ledgerFile, { kind: "served", at: new Date().toISOString(), id: run.id, repo: run.repo });
        const recipe = this.recipes.byCard(run.id);
        if (recipe) this.recipes.update(recipe.id, { status: "merged" });
        this.moveCard(run.id, this.cfg.lanes.served, `✅ merged · [PR !${run.prId}](${run.prUrl})`);
        this.log(`[${run.id}] served (PR !${run.prId} completed)`);
        await this.cleanUp(run.id);
      } else if (status === "abandoned") {
        this.state.upsert({ id: run.id, status: "blocked", reason: "PR abandoned" });
        appendLedger(this.cfg.ledgerFile, { kind: "abandoned", at: new Date().toISOString(), id: run.id, repo: run.repo });
        const recipe = this.recipes.byCard(run.id);
        if (recipe) this.recipes.update(recipe.id, { status: "failed", reason: "PR abandoned" });
        this.moveCard(run.id, this.cfg.lanes.blocked, `🚧 PR !${run.prId} was abandoned`);
      }
    }
  }

  /** Remove the worktree and local branch of a Served card. Never fails the loop. */
  async cleanUp(id: string): Promise<void> {
    const run = this.state.get(id);
    const repo = run && this.cfg.repos[run.repo];
    if (!run || !repo || run.status !== "served" || (!run.worktree && !run.branch)) return;
    try {
      const removed = await removeWorktree(this.cfg, repo, run.worktree, run.branch);
      this.state.upsert({ id, worktree: undefined });
      if (removed.length) this.log(`[${id}] cleaned up ${removed.join(" and ")}`);
    } catch (err) {
      this.log(`[${id}] cleanup failed, will retry: ${(err as Error).message}`);
    }
  }

  /** On the configured weekday, put last week's stats in the digest (once). Never fails the loop. */
  weeklyStats(now = new Date()): string | undefined {
    if (this.cfg.weeklyStatsDay === undefined || now.getDay() !== this.cfg.weeklyStatsDay) return undefined;
    try {
      const file = writeWeeklyStats(this.cfg, now);
      if (file) this.log(`weekly stats written to ${file}`);
      return file;
    } catch (err) {
      this.log(`weekly stats failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** One pass of the loop. Returns true if a card was handled. */
  async tick(selector?: string): Promise<boolean> {
    await this.checkServed();
    this.weeklyStats();
    try {
      this.syncRecipes();
    } catch (err) {
      this.log(`recipe sync failed: ${(err as Error).message}`);
    }
    const claimed = this.claim(selector);
    if (!claimed) return false;
    await this.cookCard(claimed);
    return true;
  }

  async loop(): Promise<void> {
    this.recover();
    this.log(`Chief is on: watching ${this.cfg.boardPath} every ${this.cfg.pollSeconds}s`);
    while (!this.stopping) {
      let worked = false;
      try {
        worked = await this.tick();
      } catch (err) {
        this.log(`tick failed: ${(err as Error).message}`);
      }
      if (!worked && !this.stopping) {
        await new Promise((r) => setTimeout(r, this.cfg.pollSeconds * 1000));
      }
    }
  }
}
