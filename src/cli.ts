#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { adoFor } from "./ado.js";
import { readBoard } from "./board.js";
import { Chief } from "./chief.js";
import { callClaude } from "./claude.js";
import { ConfigError, DEFAULT_CONFIG_PATH, expandHome, loadConfig, type Config } from "./config.js";
import { computeStats, formatStats, readLedger } from "./ledger.js";
import { notify, writeWeeklyStats } from "./notify.js";
import { KIND_LABEL, RecipeStore, removeLearnedTool } from "./recipes.js";
import { git, killAll, run } from "./run.js";
import { StateStore } from "./state.js";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

const HELP = `chief: an always-on local software kitchen

Usage:
  chief init [--board <path-in-work-vault>]   write ~/.config/chief/config.json (+ a starter board)
  chief doctor [--smoke] [--notify]           check config, board, repos, claude, az, notifications
  chief run [--card <id|title text>]          cook one card now (first Ready card by default)
  chief daemon                                watch the board forever (what launchd runs)
  chief status                                board lanes + recent runs
  chief stats [--repo <name>] [--weeks <n>]   pass rate, rounds, blocked reasons (default 4 weeks)
  chief stats --digest                        write last week's stats into today's digest now
  chief recipes [--repo <name>]               the recipe book: proposed, applied, rejected rules
  chief recipes revert <r-id>                 undo an applied allow-tool recipe
  chief triage [--all]                        score new Backlog cards now (--all: re-score them all)
  chief morning                               send the morning summary now

Options:
  --config <path>   config file (default: ${DEFAULT_CONFIG_PATH}, or $CHIEF_CONFIG)`;

function cfgOrExit(path: string): Config {
  try {
    return loadConfig(path);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

function init(configPath: string, board?: string): void {
  if (existsSync(configPath)) {
    console.log(`config already exists: ${configPath} (left unchanged)`);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    const example = JSON.parse(readFileSync(join(TEMPLATES, "config.example.json"), "utf8")) as Record<string, unknown>;
    if (board) example.boardPath = board;
    writeFileSync(configPath, JSON.stringify(example, null, 2) + "\n");
    console.log(`wrote ${configPath}. Edit "repos" (and "ado") before running.`);
  }
  if (board) {
    const boardPath = expandHome(board);
    if (existsSync(boardPath)) {
      console.log(`board already exists: ${boardPath} (left unchanged)`);
    } else {
      mkdirSync(dirname(boardPath), { recursive: true });
      copyFileSync(join(TEMPLATES, "board.example.md"), boardPath);
      console.log(`created board ${boardPath}. Open it in Obsidian with the Kanban plugin.`);
    }
  }
}

async function doctor(configPath: string, smoke: boolean, testNotify: boolean): Promise<number> {
  let failures = 0;
  const check = (ok: boolean, label: string, hint = ""): void => {
    console.log(`${ok ? "✓" : "✗"} ${label}${!ok && hint ? `\n    → ${hint}` : ""}`);
    if (!ok) failures++;
  };

  let cfg: Config;
  try {
    cfg = loadConfig(configPath);
    check(true, `config ${configPath}`);
  } catch (err) {
    check(false, `config ${configPath}`, (err as Error).message);
    return 1;
  }

  if (existsSync(cfg.boardPath)) {
    const board = readBoard(cfg.boardPath);
    const missing = Object.values(cfg.lanes).filter((l) => !board.lane(l));
    check(missing.length === 0, `board ${cfg.boardPath}`, `missing lanes: ${missing.join(", ")}`);
  } else {
    check(false, `board ${cfg.boardPath}`, "file not found (chief init --board <path>)");
  }

  for (const repo of Object.values(cfg.repos)) {
    const inside = await git(["rev-parse", "--is-inside-work-tree"], repo.path).catch(() => undefined);
    check(inside?.code === 0, `repo ${repo.name}: ${repo.path} is a git repo`);
    if (inside?.code !== 0) continue;
    const branch = await git(["rev-parse", "--verify", "--quiet", repo.defaultBranch], repo.path);
    check(branch.code === 0, `repo ${repo.name}: branch ${repo.defaultBranch} exists`);
    const email = await git(["config", "user.email"], repo.path);
    check(email.code === 0 && email.stdout.trim() !== "", `repo ${repo.name}: git identity set`, "git config --global user.email you@work");
    if (cfg.openPr) {
      const origin = await git(["remote", "get-url", "origin"], repo.path);
      check(origin.code === 0, `repo ${repo.name}: has an origin remote`);
    }
    check(Boolean(repo.testCmd), `repo ${repo.name}: testCmd set`, "without tests Chief cannot check proof");
  }

  const [bin, ...pre] = cfg.claudeCmd as [string, ...string[]];
  const version = await run(bin, [...pre, "--version"]);
  check(version.code === 0, `claude CLI: ${version.stdout.trim() || bin}`, "install Claude Code and log in with your enterprise account");

  if (smoke && version.code === 0) {
    const dir = mkdtempSync(join(tmpdir(), "chief-smoke-"));
    const res = await callClaude(cfg, {
      cwd: dir,
      prompt: "Reply with exactly: ok",
      allowedTools: [],
      disallowedTools: [],
      permissionMode: cfg.workerPermissionMode,
      timeoutMs: 120_000,
    });
    check(res.ok, `headless claude -p works (permission mode "${cfg.workerPermissionMode}")`, res.error ?? "");
  }

  if (cfg.openPr) {
    const az = await run("az", ["--version"]);
    check(az.code === 0, "az CLI installed", "brew install azure-cli");
    if (az.code === 0) {
      const ext = await run("az", ["extension", "show", "--name", "azure-devops", "--output", "none"]);
      check(ext.code === 0, "az azure-devops extension", "az extension add --name azure-devops");
      const azDefaultOrg = /organization/.test((await run("az", ["devops", "configure", "--list"])).stdout);
      const noOrg = Object.values(cfg.repos).filter((r) => !adoFor(cfg, r).org).map((r) => r.name);
      check(azDefaultOrg || noOrg.length === 0,
        `Azure DevOps org configured${noOrg.length ? ` (no org for: ${noOrg.join(", ")})` : ""}`, 'set "ado.org" in config or: az devops configure --defaults organization=https://dev.azure.com/<org>');
    }
  } else {
    console.log("· openPr is false: Chief stops at a local branch (no az needed)");
  }

  console.log(cfg.teamsWebhook ? "· Teams webhook configured" : "· no Teams webhook: desktop notifications + digest");
  if (testNotify) {
    const via = await notify(cfg, { title: "Chief test", body: "If you can read this, notifications work." });
    check(via !== "digest-only", `test notification sent via ${via}`, "brew install terminal-notifier, or check the webhook URL");
  }

  console.log(failures ? `\n${failures} problem(s) found` : "\nall good");
  return failures ? 1 : 0;
}

function status(cfg: Config): void {
  if (existsSync(cfg.boardPath)) {
    const board = readBoard(cfg.boardPath);
    for (const lane of board.lanes) console.log(`${lane.name.padEnd(14)} ${lane.cards.length}`);
  }
  const runs = new StateStore(cfg.stateFile).all().slice(0, 10);
  if (runs.length) console.log("\nrecent runs:");
  for (const r of runs) {
    const extra = r.prUrl ?? r.reason ?? r.branch ?? "";
    console.log(`  ${r.id}  ${r.status.padEnd(8)} ${r.updatedAt.slice(0, 16)}  ${r.title}${extra ? `  (${extra})` : ""}`);
  }
}

function stats(cfg: Config, repo: string | undefined, weeksArg: string | undefined): number {
  const weeks = weeksArg === undefined ? 4 : Number(weeksArg);
  if (!Number.isFinite(weeks) || weeks <= 0) {
    console.error("--weeks must be a positive number");
    return 1;
  }
  if (repo && !cfg.repos[repo]) {
    console.error(`unknown repo "${repo}" (configured: ${Object.keys(cfg.repos).join(", ")})`);
    return 1;
  }
  const since = new Date(Date.now() - weeks * 7 * 24 * 3600_000);
  const events = readLedger(cfg.ledgerFile);
  console.log(formatStats(computeStats(events, { repo, since }), weeks));
  if (!repo && Object.keys(cfg.repos).length > 1) {
    for (const name of Object.keys(cfg.repos)) {
      const s = computeStats(events, { repo: name, since });
      if (s.attempts) console.log(`\n${formatStats(s, weeks)}`);
    }
  }
  return 0;
}

function recipes(cfg: Config, args: string[], repo: string | undefined): number {
  const store = new RecipeStore(cfg.recipesFile);
  if (args[0] === "revert") {
    const id = args[1];
    const r = id ? store.get(id) : undefined;
    if (!r) {
      console.error(id ? `no recipe ${id}` : "usage: chief recipes revert <r-id>");
      return 1;
    }
    if (r.kind === "allow-tool") {
      const removed = removeLearnedTool(cfg.learnedFile, r.id);
      store.update(r.id, { status: "reverted", reason: "reverted with chief recipes revert" });
      console.log(removed ? `removed ${r.text} from ${cfg.learnedFile}` : `${r.text} was not in ${cfg.learnedFile}; marked reverted`);
      return 0;
    }
    if (r.status === "proposed") {
      console.log(`${r.id} is still a proposal: check it off or delete its card on the board to reject it`);
      return 0;
    }
    const where = r.prUrl ? `PR !${r.prId} (${r.prUrl})` : "its branch";
    console.log(`${r.id} changed ${KIND_LABEL[r.kind]} through ${where}. Revert it in the repo: delete the line, or revert the PR's merge. Then run this again once it's gone to mark it reverted.`);
    if (r.status === "merged" || r.status === "applied") store.update(r.id, { status: "reverted", reason: "reverted by hand" });
    return 0;
  }
  const list = store.all().filter((r) => !repo || r.repo === repo);
  if (!list.length) {
    console.log("the recipe book is empty");
    return 0;
  }
  for (const r of list) {
    const extra = r.prUrl ?? r.reason ?? "";
    console.log(`${r.id}  ${r.status.padEnd(9)} ${r.repo.padEnd(14)} ${KIND_LABEL[r.kind].padEnd(9)} ${r.text}${extra ? `  (${extra})` : ""}`);
  }
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      board: { type: "string" },
      card: { type: "string" },
      repo: { type: "string" },
      weeks: { type: "string" },
      digest: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      smoke: { type: "boolean", default: false },
      notify: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const configPath = values.config ? expandHome(values.config) : DEFAULT_CONFIG_PATH;
  const command = positionals[0];

  switch (command) {
    case "init":
      init(configPath, values.board);
      return 0;
    case "doctor":
      return doctor(configPath, values.smoke ?? false, values.notify ?? false);
    case "status":
      status(cfgOrExit(configPath));
      return 0;
    case "recipes":
      return recipes(cfgOrExit(configPath), positionals.slice(1), values.repo);
    case "stats": {
      const cfg = cfgOrExit(configPath);
      if (values.digest) {
        const file = writeWeeklyStats(cfg);
        console.log(file ? `weekly stats written to ${file}` : "nothing written: no runs last week, or today's digest already has them");
        return 0;
      }
      return stats(cfg, values.repo, values.weeks);
    }
    case "triage": {
      const cfg = cfgOrExit(configPath);
      const chief = new Chief(cfg, new StateStore(cfg.stateFile));
      const n = await chief.triageBacklog({ force: true, all: values.all ?? false });
      console.log(n ? `scored ${n} Backlog card(s)` : "nothing scored: no unscored cards in Backlog, or the call failed (see above)");
      return 0;
    }
    case "morning": {
      const cfg = cfgOrExit(configPath);
      const chief = new Chief(cfg, new StateStore(cfg.stateFile));
      const note = await chief.morningDigest(new Date(), true);
      console.log(note ? `${note.title}\n${note.body}` : "quiet: nothing ran yesterday and nothing is waiting");
      return 0;
    }
    case "run": {
      const cfg = cfgOrExit(configPath);
      const chief = new Chief(cfg, new StateStore(cfg.stateFile));
      const worked = await chief.tick(values.card);
      if (!worked) console.log(values.card ? `no card matching "${values.card}" in Ready/Backlog` : "nothing in Ready");
      return 0;
    }
    case "daemon": {
      const cfg = cfgOrExit(configPath);
      const chief = new Chief(cfg, new StateStore(cfg.stateFile));
      const shutdown = (sig: string): void => {
        console.log(`${sig}: stopping workers and exiting (the interrupted card goes to Blocked on next start)`);
        chief.stop();
        killAll();
        setTimeout(() => process.exit(0), 1000).unref();
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
      await chief.loop();
      return 0;
    }
    default:
      console.log(HELP);
      return command && !values.help ? 1 : 0;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  },
);
