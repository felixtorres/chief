import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The recipe book: small rules Chief learns from its own runs. Each one is proposed by the
 * reflector, approved by you on the board, and lands in the repo (through a draft PR) or in
 * the local learned.json overlay. Nothing here reaches a worker before you approve it.
 */
export type RecipeKind = "review-rule" | "claude-rule" | "allow-tool" | "lint-card";
export const RECIPE_KINDS: readonly RecipeKind[] = ["review-rule", "claude-rule", "allow-tool", "lint-card"];

export type RecipeStatus = "proposed" | "applying" | "applied" | "merged" | "rejected" | "reverted" | "failed";

export interface Recipe {
  id: string;
  kind: RecipeKind;
  repo: string;
  text: string;
  why: string;
  evidence: string[];
  dedupeKey: string;
  status: RecipeStatus;
  /** The card whose run produced this proposal. */
  fromCard: string;
  /** The #chief- id the recipe card got when you approved it. */
  cardId?: string;
  prId?: number;
  prUrl?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Proposal {
  kind: RecipeKind;
  text: string;
  why: string;
  evidence: string[];
  dedupeKey: string;
}

export const KIND_LABEL: Record<RecipeKind, string> = {
  "review-rule": "REVIEW.md",
  "claude-rule": "CLAUDE.md",
  "allow-tool": "allow",
  "lint-card": "lint",
};

export const RULE_FILE: Partial<Record<RecipeKind, string>> = { "review-rule": "REVIEW.md", "claude-rule": "CLAUDE.md" };
export const RECIPES_HEADING = "## Chief recipes";
export const MAX_PROPOSALS = 2;
const MAX_TEXT = 200;

export function newRecipeId(): string {
  return `r-${randomBytes(3).toString("hex")}`;
}

/** JSON-file store, same shape as StateStore: one Chief process owns it, atomic rename. */
export class RecipeStore {
  private recipes: Record<string, Recipe> = {};

  constructor(private file: string) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { recipes?: Record<string, Recipe> };
      this.recipes = parsed.recipes ?? {};
    }
  }

  get(id: string): Recipe | undefined {
    return this.recipes[id];
  }

  all(): Recipe[] {
    return Object.values(this.recipes).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  byRepo(repo: string): Recipe[] {
    return this.all().filter((r) => r.repo === repo);
  }

  byCard(cardId: string): Recipe | undefined {
    return this.all().find((r) => r.cardId === cardId);
  }

  /** A proposal with this key was already made for this repo, whatever became of it. */
  has(repo: string, dedupeKey: string): boolean {
    return this.all().some((r) => r.repo === repo && r.dedupeKey === dedupeKey);
  }

  add(r: Omit<Recipe, "createdAt" | "updatedAt" | "status"> & { status?: RecipeStatus }): Recipe {
    const now = new Date().toISOString();
    const recipe: Recipe = { status: "proposed", ...r, createdAt: now, updatedAt: now };
    this.recipes[recipe.id] = recipe;
    this.save();
    return recipe;
  }

  update(id: string, patch: Partial<Recipe>): Recipe | undefined {
    const cur = this.recipes[id];
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id, updatedAt: new Date().toISOString() };
    this.recipes[id] = next;
    this.save();
    return next;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ recipes: this.recipes }, null, 2));
    renameSync(tmp, this.file);
  }
}

// ---------------------------------------------------------------- vetting proposals

/** First words that run (or escalate) arbitrary commands, whatever follows them. */
const NEVER = new Set(["bash", "sh", "zsh", "fish", "eval", "exec", "sudo", "su", "doas", "env", "xargs", "ssh", "scp", "rsync", "rm", "chmod", "chown", "dd"]);
/** Interpreters: a specific script is fine, but not inline code (-c / -e …). */
const INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "ruby", "perl"]);
/** Bare tools whose whole prefix would allow far more than any one task needs. */
const TOO_BROAD = new Set([...INTERPRETERS, "npx", "pnpx", "bunx", "git", "npm", "pnpm", "yarn", "make", "docker", "kubectl", "az", "gh"]);

/**
 * Why a learned allowlist entry is unacceptable, or undefined if it's fine. Only narrow
 * `Bash(<command prefix>)` entries can be learned; nothing that overlaps a denied tool.
 */
export function allowToolProblem(tool: string, disallowed: string[]): string | undefined {
  const m = /^Bash\(([^()]+?)(:\*)?\)$/.exec(tool.trim());
  if (!m) return "only Bash(<command prefix>:*) entries can be learned";
  const cmd = m[1]!.trim().replace(/\s+/g, " ");
  if (!cmd) return "empty command";
  if (/[;&|`$<>\\*(){}\n]/.test(cmd)) return "shell metacharacters are not allowed";
  const [first, second] = cmd.split(" ");
  if (NEVER.has(first!)) return `"${first}" can run arbitrary commands`;
  if (TOO_BROAD.has(cmd)) return `"${cmd}" is too broad: it would allow arbitrary commands`;
  if (INTERPRETERS.has(first!) && second?.startsWith("-")) return `"${first} ${second}" runs inline code`;
  for (const d of disallowed) {
    const dm = /^Bash\((.+?)(:\*)?\)$/.exec(d);
    if (!dm) continue;
    const denied = dm[1]!.trim();
    if (cmd === denied || cmd.startsWith(denied + " ") || denied.startsWith(cmd + " ")) {
      return `overlaps the denied ${d}`;
    }
  }
  return undefined;
}

/** A clean Proposal, or the reason this one was dropped. */
export function vetProposal(raw: unknown, disallowed: string[]): Proposal | string {
  if (!raw || typeof raw !== "object") return "not an object";
  const p = raw as Record<string, unknown>;
  const kind = String(p.kind ?? "") as RecipeKind;
  if (!RECIPE_KINDS.includes(kind)) return `unknown kind "${String(p.kind)}"`;
  const text = String(p.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "empty text";
  if (text.length > MAX_TEXT) return `text longer than ${MAX_TEXT} characters`;
  const evidence = Array.isArray(p.evidence) ? p.evidence.map((e) => String(e).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5) : [];
  if (!evidence.length) return "no evidence cited";
  const dedupeKey = String(p.dedupeKey ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(dedupeKey)) return `bad dedupeKey "${dedupeKey}"`;
  if (kind === "allow-tool") {
    const problem = allowToolProblem(text, disallowed);
    if (problem) return `allow-tool ${text}: ${problem}`;
  }
  const why = String(p.why ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return { kind, text, why, evidence: evidence.map((e) => e.slice(0, 200)), dedupeKey };
}

export function parseProposals(text: string, disallowed: string[]): { proposals: Proposal[]; dropped: string[]; error?: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let data: { proposals?: unknown };
  try {
    data = JSON.parse(candidate) as { proposals?: unknown };
  } catch {
    return { proposals: [], dropped: [], error: "reflector reply was not JSON" };
  }
  const list = Array.isArray(data.proposals) ? data.proposals : [];
  const proposals: Proposal[] = [];
  const dropped: string[] = [];
  for (const raw of list) {
    const v = vetProposal(raw, disallowed);
    if (typeof v === "string") dropped.push(v);
    else if (proposals.length >= MAX_PROPOSALS) dropped.push(`over the limit of ${MAX_PROPOSALS}: ${v.dedupeKey}`);
    else if (proposals.some((q) => q.dedupeKey === v.dedupeKey)) dropped.push(`duplicate key ${v.dedupeKey}`);
    else proposals.push(v);
  }
  return { proposals, dropped };
}

// ---------------------------------------------------------------- board cards

export function recipeCardText(r: Pick<Recipe, "kind" | "text" | "repo" | "id">): string {
  return `📖 ${KIND_LABEL[r.kind]}: ${r.text} #repo/${r.repo} #recipe/${r.id}`;
}

export function recipeCardNotes(r: Pick<Recipe, "why" | "evidence">): string[] {
  return [
    `\twhy: ${r.why || "(none given)"}`,
    `\tevidence: ${r.evidence.join("; ")}`,
    "\tMove to Ready to apply · check it off or delete it to reject",
  ];
}

/** The rule text from a recipe card's clean title (you may have edited it before approving). */
export function recipeTextFromTitle(cleanTitle: string): string {
  return cleanTitle.replace(/^📖\s*[\w.-]+:\s*/u, "").trim();
}

// ---------------------------------------------------------------- rule files

/**
 * Add `- <text>` under "## Chief recipes" in REVIEW.md / CLAUDE.md content, creating the
 * section (or the file) as needed. Undefined if the rule is already there.
 */
export function addRuleLine(content: string | undefined, file: string, text: string): string | undefined {
  const line = `- ${text}`;
  const intro = "<!-- Rules Chief learned from its own runs. Each one was approved on the board. -->";
  if (content === undefined || !content.trim()) {
    const title = file === "REVIEW.md" ? "# Review guidelines" : "# CLAUDE.md";
    return `${title}\n\n${RECIPES_HEADING}\n\n${intro}\n${line}\n`;
  }
  const lines = content.replace(/\n*$/, "").split("\n");
  if (lines.some((l) => l.trim() === line)) return undefined;
  const h = lines.findIndex((l) => l.trim() === RECIPES_HEADING);
  if (h === -1) return `${lines.join("\n")}\n\n${RECIPES_HEADING}\n\n${intro}\n${line}\n`;
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  let at = end;
  while (at > h + 1 && lines[at - 1]!.trim() === "") at--;
  lines.splice(at, 0, ...(at === h + 1 ? ["", line] : [line]));
  return lines.join("\n") + "\n";
}

/** The "## Chief recipes" section of a rule file, for the reflector to see what exists. */
export function recipesSection(content: string | undefined): string {
  if (!content) return "";
  const lines = content.split("\n");
  const h = lines.findIndex((l) => l.trim() === RECIPES_HEADING);
  if (h === -1) return "";
  const out: string[] = [];
  for (let i = h + 1; i < lines.length && !/^#{1,2} /.test(lines[i]!); i++) out.push(lines[i]!);
  return out.join("\n").trim();
}

// ---------------------------------------------------------------- learned.json overlay

export interface LearnedTool {
  tool: string;
  recipe: string;
  at: string;
  evidence: string[];
}

interface Learned {
  allowedTools: Record<string, LearnedTool[]>;
}

export function readLearned(file: string): Learned {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Learned>;
    return { allowedTools: parsed.allowedTools ?? {} };
  } catch {
    return { allowedTools: {} };
  }
}

function writeLearned(file: string, learned: Learned): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(learned, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Learned allowlist entries for a repo, re-validated so a hand-edited file can't widen access. */
export function learnedTools(file: string, repo: string, disallowed: string[]): string[] {
  return (readLearned(file).allowedTools[repo] ?? []).map((t) => t.tool).filter((t) => !allowToolProblem(t, disallowed));
}

export function addLearnedTool(file: string, repo: string, entry: LearnedTool): void {
  const learned = readLearned(file);
  const list = learned.allowedTools[repo] ?? [];
  if (!list.some((t) => t.tool === entry.tool)) list.push(entry);
  learned.allowedTools[repo] = list;
  writeLearned(file, learned);
}

/** Remove whatever a recipe added. Returns true if something was removed. */
export function removeLearnedTool(file: string, recipe: string): boolean {
  const learned = readLearned(file);
  let removed = false;
  for (const [repo, list] of Object.entries(learned.allowedTools)) {
    const kept = list.filter((t) => t.recipe !== recipe);
    if (kept.length !== list.length) removed = true;
    learned.allowedTools[repo] = kept;
  }
  if (removed) writeLearned(file, learned);
  return removed;
}
