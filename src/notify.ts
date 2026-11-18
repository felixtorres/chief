import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { readLedger, WEEKLY_MARKER, weeklyStatsBlock } from "./ledger.js";
import { run } from "./run.js";

export interface Note {
  title: string;
  body: string;
  url?: string;
  /** false: already in the digest (a whole block), so only send it to Teams / the desktop. */
  digest?: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function digestFile(cfg: Config, now: Date): string {
  return join(cfg.digestDir, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`);
}

export function appendDigest(cfg: Config, note: Note, now = new Date()): string {
  mkdirSync(cfg.digestDir, { recursive: true });
  const file = digestFile(cfg, now);
  const link = note.url ? ` [PR](${note.url})` : "";
  appendFileSync(file, `- ${pad(now.getHours())}:${pad(now.getMinutes())} **${note.title}**: ${note.body.replace(/\n+/g, " ")}${link}\n`);
  return file;
}

/** Does today's digest already hold the block with this marker? */
export function digestHas(cfg: Config, marker: string, now = new Date()): boolean {
  const file = digestFile(cfg, now);
  return existsSync(file) && readFileSync(file, "utf8").includes(marker);
}

/** Append a Markdown block (that carries its own marker) to today's digest. */
export function appendDigestBlock(cfg: Config, block: string, now = new Date()): string {
  mkdirSync(cfg.digestDir, { recursive: true });
  const file = digestFile(cfg, now);
  appendFileSync(file, block);
  return file;
}

/**
 * Add last week's stats to today's digest, once per day. Returns the file written, or
 * undefined if it was already there or there was nothing to report.
 */
export function writeWeeklyStats(cfg: Config, now = new Date()): string | undefined {
  if (digestHas(cfg, WEEKLY_MARKER, now)) return undefined;
  const block = weeklyStatsBlock(readLedger(cfg.ledgerFile), Object.keys(cfg.repos), now);
  return block ? appendDigestBlock(cfg, block, now) : undefined;
}

/** Teams "Workflows" incoming webhook (the successor to retired O365 connectors). */
async function postTeams(webhook: string, note: Note): Promise<boolean> {
  const body = [
    { type: "TextBlock", text: note.title, weight: "Bolder", size: "Medium", wrap: true },
    // One TextBlock per line: Teams doesn't reliably render a bare "\n" inside one.
    ...note.body.split("\n").filter((l) => l.trim()).map((text) => ({ type: "TextBlock", text, wrap: true })),
  ];
  const card = {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body,
        ...(note.url ? { actions: [{ type: "Action.OpenUrl", title: "Open PR", url: note.url }] } : {}),
      },
    }],
  };
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function desktop(note: Note): Promise<boolean> {
  const body = note.url ? `${note.body} ${note.url}` : note.body;
  if (process.platform === "darwin") {
    const tn = await run("terminal-notifier", ["-title", "Chief", "-subtitle", note.title, "-message", body, ...(note.url ? ["-open", note.url] : [])]);
    if (tn.code === 0) return true;
    const script = `display notification ${JSON.stringify(body)} with title "Chief" subtitle ${JSON.stringify(note.title)}`;
    return (await run("osascript", ["-e", script])).code === 0;
  }
  return (await run("notify-send", ["Chief: " + note.title, body])).code === 0;
}

/** Digest file (unless note.digest is false); then Teams if configured and reachable, otherwise a desktop notification. */
export async function notify(cfg: Config, note: Note): Promise<"teams" | "desktop" | "digest-only"> {
  if (note.digest !== false) appendDigest(cfg, note);
  if (cfg.teamsWebhook && (await postTeams(cfg.teamsWebhook, note))) return "teams";
  return (await desktop(note)) ? "desktop" : "digest-only";
}
