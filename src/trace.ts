import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Config } from "./config.js";
import type { Blast } from "./state.js";

/** One tool call the agent made, as recorded in its stream-json transcript. */
export interface ToolStep {
  at?: string;
  tool: string;
  detail: string;
  ok: boolean;
  /** First line of the tool's error output, when it failed. */
  note?: string;
}

export interface CallSummary {
  sessionId?: string;
  model?: string;
  steps: ToolStep[];
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

type Raw = Record<string, unknown>;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function describeInput(tool: string, input: Raw, cwd?: string): string {
  const rel = (p: unknown): string => {
    const s = String(p ?? "");
    return cwd && s.startsWith(cwd + "/") ? relative(cwd, s) : s;
  };
  switch (tool) {
    case "Bash":
      return String(input.command ?? "");
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return rel(input.file_path ?? input.notebook_path);
    case "Grep":
      return `${String(input.pattern ?? "")}${input.path ? ` in ${rel(input.path)}` : ""}`;
    case "Glob":
      return String(input.pattern ?? "");
    case "Task":
    case "Agent":
      return String(input.description ?? input.prompt ?? "");
    default:
      return JSON.stringify(input);
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as Raw).text) : "")).join(" ");
  }
  return "";
}

/** Turn a stream-json transcript into the list of tool calls the agent made, in order. */
export function summarizeTranscript(text: string): CallSummary {
  const summary: CallSummary = { steps: [] };
  const byId = new Map<string, ToolStep>();
  let cwd: string | undefined;
  for (const line of text.split("\n")) {
    let ev: Raw;
    try {
      ev = JSON.parse(line) as Raw;
    } catch {
      continue;
    }
    const content = ((ev.message as Raw | undefined)?.content ?? []) as Raw[];
    if (ev.type === "system" && ev.subtype === "init") {
      summary.sessionId = ev.session_id as string | undefined;
      summary.model = ev.model as string | undefined;
      cwd = ev.cwd as string | undefined;
    } else if (ev.type === "assistant" && Array.isArray(content)) {
      for (const c of content) {
        if (c.type !== "tool_use") continue;
        const tool = String(c.name ?? "tool");
        const step: ToolStep = {
          at: typeof ev.timestamp === "string" ? ev.timestamp : undefined,
          tool,
          detail: describeInput(tool, (c.input ?? {}) as Raw, cwd),
          ok: true,
        };
        summary.steps.push(step);
        if (typeof c.id === "string") byId.set(c.id, step);
      }
    } else if (ev.type === "user" && Array.isArray(content)) {
      for (const c of content) {
        if (c.type !== "tool_result") continue;
        const step = byId.get(String(c.tool_use_id));
        if (step && c.is_error) {
          step.ok = false;
          step.note = oneLine(resultText(c.content), 160);
        }
      }
    } else if (ev.type === "result") {
      summary.sessionId ??= ev.session_id as string | undefined;
      summary.costUsd = ev.total_cost_usd as number | undefined;
      summary.durationMs = ev.duration_ms as number | undefined;
      summary.numTurns = ev.num_turns as number | undefined;
    }
  }
  return summary;
}

export type Role = "worker" | "reviewer";

export type Entry =
  | { kind: "agent"; role: Role; round: number; trace: string; summary: CallSummary; denials: string[]; error?: string }
  | { kind: "checks"; round: number; ok: boolean; report: string }
  | { kind: "review"; round: number; verdict: string; blast: Blast; findings: string[] }
  | { kind: "note"; round: number; text: string }
  | { kind: "outcome"; status: "pass" | "blocked"; text: string };

const BLAST_ICON: Record<Blast, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

function duration(ms?: number): string {
  if (ms === undefined) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function time(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8);
}

/** Show a path under the home directory as ~/…, so PRs don't carry your username. */
export function tildify(path: string, home = homedir()): string {
  return path === home ? "~" : path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/** Inline code that survives being inside a Markdown table cell. */
function cell(text: string, max = 140): string {
  const t = oneLine(text, max).replace(/`/g, "'").replace(/\|/g, "\\|");
  return t ? `\`${t}\`` : "";
}

/**
 * The per-card run log: what the worker and reviewer did (every tool call), what Chief's own
 * checks said, and how it ended. Rewritten after every step so it can be watched live.
 */
export class RunLog {
  readonly path: string;
  private readonly previous: string;
  private readonly attempt: number;
  private readonly startedAt = new Date();
  private readonly stamp: string;
  private entries: Entry[] = [];

  constructor(
    private cfg: Config,
    private card: { id: string; title: string; repo: string },
    private branch: string,
  ) {
    this.path = join(cfg.runsDir, `chief-${card.id}.md`);
    let previous = "";
    try {
      previous = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
    } catch {
      // unreadable old log: start fresh
    }
    // Keep earlier attempts of the same card; drop the old header, it is rewritten.
    const firstAttempt = previous.indexOf("\n## Attempt ");
    this.previous = firstAttempt >= 0 ? previous.slice(firstAttempt + 1).trimEnd() : "";
    this.attempt = (this.previous.match(/^## Attempt /gm) ?? []).length + 1;
    this.stamp = this.startedAt.toISOString().replace(/[:.]/g, "-");
  }

  /** Where the raw transcript of one agent call goes. */
  traceFile(round: number, role: Role): string {
    return join(this.cfg.tracesDir, this.card.id, `${this.stamp}-r${round}-${role}.jsonl`);
  }

  add(entry: Entry): void {
    this.entries.push(entry);
    this.write();
  }

  /** Record one finished agent call, reading its transcript back from disk. */
  addAgent(role: Role, round: number, trace: string, denials: string[], error?: string): CallSummary {
    let text = "";
    try {
      text = readFileSync(trace, "utf8");
    } catch {
      // the call never started (spawn failure); the error says why
    }
    const summary = summarizeTranscript(text);
    this.add({ kind: "agent", role, round, trace, summary, denials, error });
    return summary;
  }

  write(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const body = [this.header(), this.renderAttempt(), this.previous].filter(Boolean).join("\n\n");
      writeFileSync(this.path, body.trimEnd() + "\n");
    } catch {
      // The run log is for humans; never let it break a run.
    }
  }

  private header(): string {
    return [
      `# Chief run: ${this.card.title}`,
      "",
      `Card \`#chief-${this.card.id}\` · repo \`${this.card.repo}\` · branch \`${this.branch}\``,
      "",
      "Newest attempt first. Raw transcripts are linked per call.",
    ].join("\n");
  }

  private renderAttempt(): string {
    const out: string[] = [`## Attempt ${this.attempt} · ${this.startedAt.toLocaleString("en-CA", { hour12: false })}`];
    let round = 0;
    for (const e of this.entries) {
      if (e.kind !== "outcome" && e.round !== round) {
        round = e.round;
        out.push("", `### Round ${round}`);
      }
      out.push("", ...this.renderEntry(e));
    }
    if (!this.entries.some((e) => e.kind === "outcome")) out.push("", "_In progress…_");
    return out.join("\n");
  }

  private renderEntry(e: Entry): string[] {
    switch (e.kind) {
      case "agent": {
        const s = e.summary;
        const meta = [
          duration(s.durationMs),
          s.numTurns !== undefined ? `${s.numTurns} turns` : "",
          s.costUsd !== undefined ? `$${s.costUsd.toFixed(2)}` : "",
          s.model ? `model \`${s.model}\`` : "",
          s.sessionId ? `session \`${s.sessionId}\`` : "",
        ].filter(Boolean);
        const lines = [`**${e.role === "worker" ? "Worker" : "Reviewer"}**${meta.length ? " · " + meta.join(" · ") : ""}`];
        if (s.steps.length) {
          lines.push("", "| time | | tool | what |", "|---|---|---|---|");
          for (const st of s.steps) {
            lines.push(`| ${time(st.at)} | ${st.ok ? "✓" : "✗"} | ${st.tool} | ${cell(st.detail)}${st.note ? ` → ${cell(st.note, 120)}` : ""} |`);
          }
        } else {
          lines.push("", "No tool calls.");
        }
        if (e.denials.length) lines.push("", `**Denied by the allowlist:** ${[...new Set(e.denials)].map((d) => cell(d)).join(", ")}`);
        if (e.error) lines.push("", `**Error:** ${oneLine(e.error, 400)}`);
        lines.push("", `Transcript: \`${e.trace}\``);
        return lines;
      }
      case "checks":
        return [`**Chief's checks** ${e.ok ? "✓ passed" : "✗ failed"}`, "", e.report];
      case "review":
        return [
          `**Review verdict:** ${e.verdict} · ${BLAST_ICON[e.blast]} ${e.blast}`,
          ...(e.findings.length ? ["", ...e.findings.map((f) => `- ${f}`)] : []),
        ];
      case "note":
        return [`> ${oneLine(e.text, 600)}`];
      case "outcome":
        return ["### Outcome", "", `${e.status === "pass" ? "✅" : "🚧"} ${oneLine(e.text, 800)}`];
    }
  }

  /** Compact activity section for the PR description (reviewers can't open the vault). */
  activity(): string {
    const lines: string[] = [];
    for (const e of this.entries) {
      if (e.kind !== "agent") continue;
      const s = e.summary;
      const cmds = [...new Set(s.steps.filter((st) => st.tool === "Bash").map((st) => `${st.ok ? "✓" : "✗"} \`${oneLine(st.detail, 120).replace(/`/g, "'")}\``))];
      const edited = [...new Set(s.steps.filter((st) => ["Edit", "Write", "NotebookEdit"].includes(st.tool)).map((st) => `\`${st.detail}\``))];
      const head = `- Round ${e.round} ${e.role}: ${s.steps.length} tool calls${s.durationMs !== undefined ? `, ${duration(s.durationMs)}` : ""}${s.costUsd !== undefined ? `, $${s.costUsd.toFixed(2)}` : ""}`;
      lines.push(head);
      if (edited.length) lines.push(`  - Edited: ${edited.slice(0, 15).join(", ")}`);
      if (cmds.length) lines.push(`  - Commands: ${cmds.slice(0, 15).join(", ")}${cmds.length > 15 ? ", …" : ""}`);
      if (e.denials.length) lines.push(`  - Denied: ${[...new Set(e.denials)].map((d) => `\`${d}\``).join(", ")}`);
    }
    lines.push("", `Full run log on the Chief host: \`${tildify(this.path)}\` (raw transcripts in \`${tildify(join(this.cfg.tracesDir, this.card.id))}\`).`);
    return lines.join("\n");
  }
}
