import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// Obsidian Kanban plugin format: lanes are "## " headings, cards are "- [ ] " list items,
// and a "%% kanban:settings" block closes the file. Chief owns only the text after
// STATUS_SEP on a card's first line, so your own card text is never rewritten.
const CARD_RE = /^- \[([ xX])\] (.*)$/;
const ID_RE = /#chief-([0-9a-f]{6})\b/;
const REPO_RE = /#repo\/([\w.-]+)/;
const TRAILER_RE = /^%% kanban:settings/;
export const STATUS_SEP = "<br>🤖 ";

export class Card {
  constructor(
    public checked: boolean,
    public text: string,
    public extra: string[] = [],
  ) {}

  get title(): string {
    const i = this.text.indexOf(STATUS_SEP);
    return i === -1 ? this.text : this.text.slice(0, i);
  }

  get status(): string {
    const i = this.text.indexOf(STATUS_SEP);
    return i === -1 ? "" : this.text.slice(i + STATUS_SEP.length);
  }

  get id(): string | undefined {
    return ID_RE.exec(this.title)?.[1];
  }

  get repo(): string | undefined {
    return REPO_RE.exec(this.title)?.[1];
  }

  /** Title without Chief/repo tags. */
  get cleanTitle(): string {
    return this.title
      .replace(new RegExp(ID_RE.source, "g"), "")
      .replace(new RegExp(REPO_RE.source, "g"), "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Extra lines of the card, without list/indent markers. */
  get notes(): string[] {
    return this.extra.map((l) => l.trim().replace(/^[-*]\s+/, "")).filter(Boolean);
  }

  ensureId(gen: () => string = newId): string {
    const existing = this.id;
    if (existing) return existing;
    const id = gen();
    const status = this.status;
    this.text = `${this.title.trimEnd()} #chief-${id}` + (status ? STATUS_SEP + status : "");
    return id;
  }

  setStatus(status: string): void {
    const clean = status.replace(/\s*\n\s*/g, " ").replaceAll("<br>", " ").trim();
    this.text = this.title.trimEnd() + (clean ? STATUS_SEP + clean : "");
  }

  render(): string[] {
    return [`- [${this.checked ? "x" : " "}] ${this.text}`, ...this.extra];
  }
}

export class Lane {
  constructor(
    public name: string,
    public prefix: string[] = [],
    public cards: Card[] = [],
  ) {}
}

export function laneKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function newId(): string {
  return randomBytes(3).toString("hex");
}

export class Board {
  constructor(
    public preamble: string[],
    public lanes: Lane[],
    public trailer: string[],
  ) {}

  static parse(text: string): Board {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    const preamble: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith("## ") && !TRAILER_RE.test(lines[i]!)) {
      preamble.push(lines[i]!);
      i++;
    }
    const lanes: Lane[] = [];
    let lane: Lane | undefined;
    let card: Card | undefined;
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (TRAILER_RE.test(line)) break;
      if (line.startsWith("## ")) {
        lane = new Lane(line.slice(3).trim());
        lanes.push(lane);
        card = undefined;
        continue;
      }
      if (!lane) continue;
      const m = CARD_RE.exec(line);
      if (m) {
        card = new Card(m[1] !== " ", m[2]!);
        lane.cards.push(card);
      } else if (card && /^\s+\S/.test(line)) {
        card.extra.push(line);
      } else if (line.trim() !== "") {
        lane.prefix.push(line);
        card = undefined;
      }
    }
    const trailer = lines.slice(i);
    return new Board(preamble, lanes, trailer);
  }

  render(): string {
    const out: string[] = [];
    const pre = trimTrailingBlank(this.preamble);
    if (pre.length) out.push(...pre, "");
    for (const lane of this.lanes) {
      out.push(`## ${lane.name}`, "");
      if (lane.prefix.length) out.push(...lane.prefix, "");
      for (const card of lane.cards) out.push(...card.render());
      if (lane.cards.length || !lane.prefix.length) out.push("");
      out.push("");
    }
    out.push(...trimTrailingBlank(this.trailer));
    return out.join("\n").replace(/\n*$/, "\n");
  }

  lane(name: string): Lane | undefined {
    const key = laneKey(name);
    return this.lanes.find((l) => laneKey(l.name) === key);
  }

  findById(id: string): { lane: Lane; card: Card } | undefined {
    for (const lane of this.lanes) {
      const card = lane.cards.find((c) => c.id === id);
      if (card) return { lane, card };
    }
    return undefined;
  }

  move(card: Card, toLane: string): void {
    const target = this.lane(toLane);
    if (!target) throw new Error(`board has no lane "${toLane}"`);
    for (const lane of this.lanes) {
      const idx = lane.cards.indexOf(card);
      if (idx !== -1) lane.cards.splice(idx, 1);
    }
    target.cards.push(card);
  }
}

function trimTrailingBlank(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length && copy[copy.length - 1]!.trim() === "") copy.pop();
  return copy;
}

export class BoardConflictError extends Error {}

/**
 * Read → mutate → write the board atomically. If the file changed on disk while we were
 * working (you editing in Obsidian), start over from the fresh copy instead of clobbering it.
 */
export function updateBoard<T>(path: string, fn: (board: Board) => T, retries = 5): T {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const before = statSync(path, { bigint: true }).mtimeNs;
    const text = readFileSync(path, "utf8");
    const board = Board.parse(text);
    const result = fn(board);
    const next = board.render();
    if (next === text) return result;
    if (statSync(path, { bigint: true }).mtimeNs !== before) continue;
    const tmp = join(dirname(path), `.${basename(path)}.chief-tmp`);
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, path);
    return result;
  }
  throw new BoardConflictError(`board ${path} kept changing; gave up after ${retries + 1} attempts`);
}

export function readBoard(path: string): Board {
  return Board.parse(readFileSync(path, "utf8"));
}
