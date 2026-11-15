import { prStatus } from "./ado.js";
import { type Card, updateBoard } from "./board.js";
import type { Config, RepoConfig } from "./config.js";
import { notify, type Note } from "./notify.js";
import { cook, type Log, type Outcome } from "./pipeline.js";
import type { Blast, StateStore } from "./state.js";

export interface Claimed {
  id: string;
  title: string;
  notes: string[];
  repo?: RepoConfig;
  problem?: string;
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

export function passStatus(o: Outcome): string {
  const blast = o.blast ? `${BLAST_ICON[o.blast]} ${o.blast}` : "";
  const where = o.prUrl ? `[PR !${o.prId}](${o.prUrl})` : `branch \`${o.branch}\``;
  return [`🔍 ${blast}`.trim(), where, `${o.rounds} round${o.rounds === 1 ? "" : "s"}`].join(" · ");
}

export class Chief {
  private lastServedCheck = 0;
  private stopping = false;

  constructor(
    private cfg: Config,
    private state: StateStore,
    private log: Log = (m) => console.log(`${new Date().toISOString()} ${m}`),
    private send: Notifier = notify,
  ) {}

  stop(): void {
    this.stopping = true;
  }

  /** Cards left in Cooking by a crash or restart go to Blocked; nothing is silently resumed. */
  recover(): number {
    const stale = this.state.byStatus("cooking");
    for (const run of stale) {
      const reason = "interrupted: Chief restarted mid-run (worktree kept)";
      this.state.upsert({ id: run.id, status: "blocked", reason });
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
      const claimed: Claimed = { id, title: card.cleanTitle, notes: card.notes, repo };
      if (!repo) {
        claimed.problem = repoName
          ? `unknown repo "${repoName}"; add it to the Chief config`
          : "no repo: tag the card with #repo/<name>";
        card.setStatus(`🚧 ${claimed.problem}`);
        board.move(card, lanes.blocked);
      } else {
        card.setStatus(`🍳 cooking since ${hhmm()}`);
        board.move(card, lanes.cooking);
      }
      return claimed;
    });
  }

  async cookCard(c: Claimed): Promise<Outcome | undefined> {
    if (!c.repo) {
      this.state.upsert({ id: c.id, title: c.title, repo: "", status: "blocked", reason: c.problem });
      await this.send(this.cfg, { title: `Blocked: ${c.title}`, body: c.problem ?? "" });
      return undefined;
    }
    this.state.upsert({ id: c.id, title: c.title, repo: c.repo.name, status: "cooking", rounds: 0, reason: undefined });
    this.log(`[${c.id}] cooking "${c.title}" in ${c.repo.name}`);

    let outcome: Outcome;
    try {
      outcome = await cook(this.cfg, { id: c.id, title: c.title, notes: c.notes, repo: c.repo }, this.log);
    } catch (err) {
      outcome = { status: "blocked", reason: `Chief error: ${(err as Error).message}`, summary: "", rounds: 0, branch: "", worktree: "" };
    }

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
      this.moveCard(c.id, this.cfg.lanes.pass, passStatus(outcome));
      await this.send(this.cfg, {
        title: `Ready at the pass: ${c.title}`,
        body: `${outcome.blast ?? "?"} blast radius, ${outcome.rounds} round(s). ${outcome.prUrl ? "Draft PR opened." : `Branch ${outcome.branch}.`}`,
        url: outcome.prUrl,
      });
    } else {
      this.moveCard(c.id, this.cfg.lanes.blocked, `🚧 ${oneLine(outcome.reason ?? "blocked")}`);
      await this.send(this.cfg, { title: `Blocked: ${c.title}`, body: oneLine(outcome.reason ?? "blocked", 400) });
    }
    this.log(`[${c.id}] → ${outcome.status}${outcome.reason ? `: ${oneLine(outcome.reason)}` : ""}`);
    return outcome;
  }

  /** Move cards whose PR was completed in Azure DevOps to Served. Rate-limited. */
  async checkServed(force = false): Promise<void> {
    if (!this.cfg.openPr) return;
    if (!force && Date.now() - this.lastServedCheck < SERVED_CHECK_MS) return;
    this.lastServedCheck = Date.now();
    for (const run of this.state.byStatus("pass")) {
      const repo = this.cfg.repos[run.repo];
      if (!run.prId || !repo) continue;
      const status = await prStatus(this.cfg, repo, run.prId);
      if (status === "completed") {
        this.state.upsert({ id: run.id, status: "served" });
        this.moveCard(run.id, this.cfg.lanes.served, `✅ merged · [PR !${run.prId}](${run.prUrl})`);
        this.log(`[${run.id}] served (PR !${run.prId} completed)`);
      } else if (status === "abandoned") {
        this.state.upsert({ id: run.id, status: "blocked", reason: "PR abandoned" });
        this.moveCard(run.id, this.cfg.lanes.blocked, `🚧 PR !${run.prId} was abandoned`);
      }
    }
  }

  /** One pass of the loop. Returns true if a card was handled. */
  async tick(selector?: string): Promise<boolean> {
    await this.checkServed();
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
