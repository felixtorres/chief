import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import { run, tail } from "./run.js";

export interface AgentCall {
  cwd: string;
  prompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
  resumeSessionId?: string;
  timeoutMs: number;
  /** Append the raw stream-json transcript here as it arrives. */
  traceFile?: string;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  error?: string;
  /** Tool calls the permission allowlist refused, e.g. `Bash: npm run e2e`. */
  denials: string[];
}

interface ClaudeJson {
  result?: unknown;
  is_error?: boolean;
  session_id?: string;
  type?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  terminal_reason?: string;
  subtype?: string;
  permission_denials?: { tool_name?: string; tool_input?: { command?: string; file_path?: string } }[];
}

function describeDenials(data: ClaudeJson): string[] {
  return (data.permission_denials ?? []).map((d) => {
    const detail = d.tool_input?.command ?? d.tool_input?.file_path ?? "";
    return `${d.tool_name ?? "tool"}${detail ? `: ${detail}` : ""}`;
  });
}

export function buildClaudeArgs(cfg: Config, call: AgentCall): { bin: string; args: string[] } {
  const [bin, ...pre] = cfg.claudeCmd as [string, ...string[]];
  // stream-json gives every tool call as it happens (the trace); the last line is the same
  // result object --output-format json would print.
  const args = [...pre, "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", call.permissionMode];
  // Only Chief's flags grant permissions: don't load the allow rules, hooks and plugins from
  // your own settings files, or your MCP servers.
  args.push("--setting-sources", cfg.settingSources);
  if (cfg.strictMcpConfig) args.push("--strict-mcp-config");
  if (cfg.model) args.push("--model", cfg.model);
  if (call.resumeSessionId) args.push("--resume", call.resumeSessionId);
  if (cfg.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(cfg.maxBudgetUsd));
  // Variadic flags go last; the prompt is sent on stdin so it can't be swallowed by them.
  if (call.allowedTools.length) args.push("--allowedTools", ...call.allowedTools);
  if (call.disallowedTools.length) args.push("--disallowedTools", ...call.disallowedTools);
  return { bin, args };
}

/** Every `result` event of a stream-json transcript (or a plain --output-format json object), in order. */
export function parseResults(stdout: string): ClaudeJson[] {
  const out: ClaudeJson[] = [];
  for (const line of stdout.trim().split("\n")) {
    try {
      const data = JSON.parse(line) as ClaudeJson;
      if (data && typeof data === "object" && (data.type === "result" || data.type === undefined)) out.push(data);
    } catch {
      // not JSON (a warning, a partial line); skip it
    }
  }
  return out;
}

const isBlocked = (t: unknown): t is string => typeof t === "string" && /^\s*BLOCKED:/i.test(t);

/**
 * One session can emit several results: when the agent starts a background command, it
 * answers, then wakes up again when the command finishes and answers once more. Merge
 * them so nothing is lost: a BLOCKED answer anywhere wins, otherwise all answers are kept
 * in order; time and turns add up; cost is already cumulative, so take the largest.
 */
export function mergeResults(results: ClaudeJson[]): ClaudeJson | undefined {
  if (results.length <= 1) return results[0];
  const last = results[results.length - 1]!;
  const texts = results.map((r) => r.result).filter((t): t is string => typeof t === "string" && t.trim() !== "");
  const sum = (k: "duration_ms" | "num_turns") =>
    results.some((r) => typeof r[k] === "number") ? results.reduce((n, r) => n + (r[k] ?? 0), 0) : undefined;
  const costs = results.map((r) => r.total_cost_usd).filter((c): c is number => typeof c === "number");
  return {
    ...last,
    result: texts.find(isBlocked) ?? texts.join("\n\n"),
    duration_ms: sum("duration_ms"),
    num_turns: sum("num_turns"),
    total_cost_usd: costs.length ? Math.max(...costs) : undefined,
    permission_denials: results.flatMap((r) => r.permission_denials ?? []),
  };
}

/** The (merged) result of a stream-json transcript. */
export function parseResult(stdout: string): ClaudeJson | undefined {
  return mergeResults(parseResults(stdout));
}

/** One headless Claude Code turn via `claude -p`, billed to whatever seat the CLI is logged into. */
export async function callClaude(cfg: Config, call: AgentCall): Promise<AgentResult> {
  const { bin, args } = buildClaudeArgs(cfg, call);
  let onStdout: ((chunk: string) => void) | undefined;
  if (call.traceFile) {
    const file = call.traceFile;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
    onStdout = (chunk) => appendFileSync(file, chunk);
  }
  const r = await run(bin, args, { cwd: call.cwd, input: call.prompt, timeoutMs: call.timeoutMs, onStdout });
  if (r.timedOut) {
    return { ok: false, text: "", denials: [], error: `timed out after ${Math.round(call.timeoutMs / 60000)} min` };
  }
  const data = parseResult(r.stdout);
  if (!data) {
    return { ok: false, text: "", denials: [], error: `claude exited ${r.code}: ${tail(r.stderr || r.stdout, 500)}` };
  }
  const text = typeof data.result === "string" ? data.result : "";
  const ok = r.code === 0 && !data.is_error;
  return {
    ok,
    text,
    sessionId: data.session_id,
    costUsd: data.total_cost_usd,
    durationMs: data.duration_ms,
    numTurns: data.num_turns,
    denials: describeDenials(data),
    error: ok ? undefined : data.terminal_reason ?? data.subtype ?? tail(r.stderr || text, 500),
  };
}
