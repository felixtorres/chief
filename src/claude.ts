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
}

export interface AgentResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd?: number;
  error?: string;
  /** Tool calls the permission allowlist refused, e.g. `Bash: npm run e2e`. */
  denials: string[];
}

interface ClaudeJson {
  result?: unknown;
  is_error?: boolean;
  session_id?: string;
  total_cost_usd?: number;
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
  const args = [...pre, "-p", "--output-format", "json", "--permission-mode", call.permissionMode];
  if (cfg.model) args.push("--model", cfg.model);
  if (call.resumeSessionId) args.push("--resume", call.resumeSessionId);
  if (cfg.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(cfg.maxBudgetUsd));
  // Variadic flags go last; the prompt is sent on stdin so it can't be swallowed by them.
  if (call.allowedTools.length) args.push("--allowedTools", ...call.allowedTools);
  if (call.disallowedTools.length) args.push("--disallowedTools", ...call.disallowedTools);
  return { bin, args };
}

function parseJson(stdout: string): ClaudeJson | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as ClaudeJson;
  } catch {
    // Fall back to the last line that parses (e.g. warnings printed before the JSON).
    for (const line of trimmed.split("\n").reverse()) {
      try {
        return JSON.parse(line) as ClaudeJson;
      } catch {
        // keep looking
      }
    }
    return undefined;
  }
}

/** One headless Claude Code turn via `claude -p`, billed to whatever seat the CLI is logged into. */
export async function callClaude(cfg: Config, call: AgentCall): Promise<AgentResult> {
  const { bin, args } = buildClaudeArgs(cfg, call);
  const r = await run(bin, args, { cwd: call.cwd, input: call.prompt, timeoutMs: call.timeoutMs });
  if (r.timedOut) {
    return { ok: false, text: "", denials: [], error: `timed out after ${Math.round(call.timeoutMs / 60000)} min` };
  }
  const data = parseJson(r.stdout);
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
    denials: describeDenials(data),
    error: ok ? undefined : data.terminal_reason ?? data.subtype ?? tail(r.stderr || text, 500),
  };
}
