import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { run } from "./run.js";

export interface Note {
  title: string;
  body: string;
  url?: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function appendDigest(cfg: Config, note: Note, now = new Date()): string {
  mkdirSync(cfg.digestDir, { recursive: true });
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const file = join(cfg.digestDir, `${day}.md`);
  const link = note.url ? ` [PR](${note.url})` : "";
  appendFileSync(file, `- ${pad(now.getHours())}:${pad(now.getMinutes())} **${note.title}**: ${note.body.replace(/\n+/g, " ")}${link}\n`);
  return file;
}

/** Teams "Workflows" incoming webhook (the successor to retired O365 connectors). */
async function postTeams(webhook: string, note: Note): Promise<boolean> {
  const body = [
    { type: "TextBlock", text: note.title, weight: "Bolder", size: "Medium", wrap: true },
    { type: "TextBlock", text: note.body, wrap: true },
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

/** Digest file always; then Teams if configured and reachable, otherwise a desktop notification. */
export async function notify(cfg: Config, note: Note): Promise<"teams" | "desktop" | "digest-only"> {
  appendDigest(cfg, note);
  if (cfg.teamsWebhook && (await postTeams(cfg.teamsWebhook, note))) return "teams";
  return (await desktop(note)) ? "desktop" : "digest-only";
}
