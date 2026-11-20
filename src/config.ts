import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface RepoConfig {
  name: string;
  path: string;
  defaultBranch: string;
  testCmd: string;
  lintCmd: string;
  /** Azure DevOps repository name; defaults to `name`. */
  adoRepository: string;
  /** Extra tools the worker may use in this repo, e.g. "Bash(npm run build:*)". */
  allowedTools: string[];
  /** Per-repo Azure DevOps org/project; falls back to the top-level "ado". */
  ado: { org?: string; project?: string };
  /**
   * Extra environment for Chief's `git push`, e.g. { "LEFTHOOK_EXCLUDE": "test-affected" } to
   * skip a pre-push hook step that only repeats the tests Chief's own checks already ran.
   */
  pushEnv: Record<string, string>;
}

export interface Lanes {
  backlog: string;
  ready: string;
  cooking: string;
  pass: string;
  blocked: string;
  served: string;
  /** Where the reflector puts proposed recipes; created on the board when first needed. */
  recipes: string;
}

export interface Config {
  boardPath: string;
  repos: Record<string, RepoConfig>;
  defaultRepo?: string;
  lanes: Lanes;
  stateFile: string;
  worktreesDir: string;
  digestDir: string;
  /** Human-readable run log per card (Markdown, meant to live in the vault next to the board). */
  runsDir: string;
  /** Raw stream-json transcripts of every worker/reviewer call. */
  tracesDir: string;
  /** One JSON line per finished attempt and PR outcome; `chief stats` reads it. */
  ledgerFile: string;
  /** Recipe book: proposals, approvals, rejections (tombstones). */
  recipesFile: string;
  /** Allowlist entries learned from approved allow-tool recipes, per repo. */
  learnedFile: string;
  /** Run the reflector after runs that went wrong (default true). */
  reflector: boolean;
  /** At most this many reflector calls per day (default 5). */
  reflectorDailyCap: number;
  /** Warn on rule proposals once a repo's "## Chief recipes" section has this many rules (default 30). */
  recipeBudget: number;
  /** How to run the Azure CLI (default ["az"]; tests use a fake). */
  azCmd: string[];
  /**
   * Which of your own Claude Code settings files workers load ("user,project,local" are the
   * options). Default "" loads none, so allow rules you approved interactively never leak in.
   */
  settingSources: string;
  /** Ignore your MCP servers in worker/reviewer sessions (default true). */
  strictMcpConfig: boolean;
  pollSeconds: number;
  claudeCmd: string[];
  model?: string;
  workerPermissionMode: string;
  reviewPermissionMode: string;
  workerTimeoutMinutes: number;
  checkTimeoutMinutes: number;
  maxRounds: number;
  maxBudgetUsd?: number;
  allowedTools: string[];
  disallowedTools: string[];
  reviewAllowedTools: string[];
  openPr: boolean;
  fetchBeforeBranch: boolean;
  ado: { org?: string; project?: string };
  teamsWebhook?: string;
  /** Weekday (0 = Sunday … 6 = Saturday) the weekly stats block goes into the digest; undefined = off. */
  weeklyStatsDay?: number;
  /** Score new Backlog cards with RICE + blast radius (default true). Advisory only. */
  triage: boolean;
  /** At most one triage call per this many minutes (default 60). */
  triageIntervalMinutes: number;
  /** Local hour (0–23) from which the morning summary goes out, once a day; undefined = off. */
  morningDigestHour?: number;
}

export const DEFAULT_CONFIG_PATH =
  process.env.CHIEF_CONFIG ?? join(homedir(), ".config", "chief", "config.json");

export const DEFAULT_LANES: Lanes = {
  backlog: "Backlog",
  ready: "Ready",
  cooking: "Cooking",
  pass: "Pass",
  blocked: "Blocked",
  served: "Served",
  recipes: "Recipes",
};

export const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(ls:*)",
];

// Workers never push, talk to Azure DevOps, or reach the network. Only Chief does that.
export const DEFAULT_DISALLOWED_TOOLS = [
  "Bash(git push:*)",
  "Bash(git remote:*)",
  "Bash(az:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "WebFetch",
  "WebSearch",
];

export const DEFAULT_REVIEW_TOOLS = ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)"];

export class ConfigError extends Error {}

export function expandHome(p: string, baseDir?: string): string {
  const expanded = p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(baseDir ?? process.cwd(), expanded);
}

type Raw = Record<string, unknown>;

function str(v: unknown, key: string, fallback?: string): string {
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`config: "${key}" is required`);
  }
  if (typeof v !== "string") throw new ConfigError(`config: "${key}" must be a string`);
  return v;
}

function strAllowEmpty(v: unknown, key: string): string {
  if (typeof v !== "string") throw new ConfigError(`config: "${key}" must be a string`);
  return v;
}

function num(v: unknown, key: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new ConfigError(`config: "${key}" must be a positive number`);
  }
  return v;
}

function strMap(v: unknown, key: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string")) {
    throw new ConfigError(`config: "${key}" must be an object of string values`);
  }
  return { ...(v as Record<string, string>) };
}

function strList(v: unknown, key: string, fallback: string[]): string[] {
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ConfigError(`config: "${key}" must be an array of strings`);
  }
  return v as string[];
}

/** 0–6 (Sunday–Saturday), default Monday; false turns the weekly block off. */
function weekday(v: unknown, key: string): number | undefined {
  if (v === undefined || v === null) return 1;
  if (v === false) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 6) {
    throw new ConfigError(`config: "${key}" must be 0–6 (0 = Sunday) or false`);
  }
  return v;
}

/** 0–23, default 8; false turns the morning summary off. */
function hour(v: unknown, key: string): number | undefined {
  if (v === undefined || v === null) return 8;
  if (v === false) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) {
    throw new ConfigError(`config: "${key}" must be 0–23 or false`);
  }
  return v;
}

function bool(v: unknown, key: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new ConfigError(`config: "${key}" must be true or false`);
  return v;
}

function adoSettings(v: unknown, key: string): { org?: string; project?: string } {
  const a = (v ?? {}) as Raw;
  return {
    org: a.org === undefined ? undefined : str(a.org, `${key}.org`),
    project: a.project === undefined ? undefined : str(a.project, `${key}.project`),
  };
}

export function parseConfig(raw: unknown, baseDir?: string): Config {
  if (!raw || typeof raw !== "object") throw new ConfigError("config: expected a JSON object");
  const r = raw as Raw;
  const stateDir = join(homedir(), ".local", "state", "chief");

  const reposRaw = r.repos;
  if (!reposRaw || typeof reposRaw !== "object" || Object.keys(reposRaw).length === 0) {
    throw new ConfigError('config: "repos" must define at least one repo');
  }
  const repos: Record<string, RepoConfig> = {};
  for (const [name, value] of Object.entries(reposRaw as Raw)) {
    const rr = (value ?? {}) as Raw;
    repos[name] = {
      name,
      path: expandHome(str(rr.path, `repos.${name}.path`), baseDir),
      defaultBranch: str(rr.defaultBranch, `repos.${name}.defaultBranch`, "main"),
      testCmd: str(rr.testCmd, `repos.${name}.testCmd`, ""),
      lintCmd: str(rr.lintCmd, `repos.${name}.lintCmd`, ""),
      adoRepository: str(rr.adoRepository, `repos.${name}.adoRepository`, name),
      allowedTools: strList(rr.allowedTools, `repos.${name}.allowedTools`, []),
      ado: adoSettings(rr.ado, `repos.${name}.ado`),
      pushEnv: strMap(rr.pushEnv, `repos.${name}.pushEnv`),
    };
  }

  const defaultRepo = r.defaultRepo === undefined ? undefined : str(r.defaultRepo, "defaultRepo");
  if (defaultRepo && !repos[defaultRepo]) {
    throw new ConfigError(`config: defaultRepo "${defaultRepo}" is not in repos`);
  }

  const lanesRaw = (r.lanes ?? {}) as Raw;
  const lanes = { ...DEFAULT_LANES };
  for (const key of Object.keys(DEFAULT_LANES) as (keyof Lanes)[]) {
    lanes[key] = str(lanesRaw[key], `lanes.${key}`, DEFAULT_LANES[key]);
  }

  const claudeCmd = strList(r.claudeCmd, "claudeCmd", ["claude"]);
  if (claudeCmd.length === 0) throw new ConfigError('config: "claudeCmd" must not be empty');

  return {
    boardPath: expandHome(str(r.boardPath, "boardPath"), baseDir),
    repos,
    defaultRepo,
    lanes,
    stateFile: expandHome(str(r.stateFile, "stateFile", join(stateDir, "state.json")), baseDir),
    worktreesDir: expandHome(str(r.worktreesDir, "worktreesDir", join(stateDir, "worktrees")), baseDir),
    digestDir: expandHome(str(r.digestDir, "digestDir", join(stateDir, "digests")), baseDir),
    runsDir: expandHome(
      str(r.runsDir, "runsDir", join(dirname(expandHome(str(r.boardPath, "boardPath"), baseDir)), "runs")),
      baseDir,
    ),
    tracesDir: expandHome(str(r.tracesDir, "tracesDir", join(stateDir, "traces")), baseDir),
    ledgerFile: expandHome(str(r.ledgerFile, "ledgerFile", join(stateDir, "ledger.jsonl")), baseDir),
    recipesFile: expandHome(str(r.recipesFile, "recipesFile", join(stateDir, "recipes.json")), baseDir),
    learnedFile: expandHome(str(r.learnedFile, "learnedFile", join(homedir(), ".config", "chief", "learned.json")), baseDir),
    reflector: bool(r.reflector, "reflector", true),
    reflectorDailyCap: num(r.reflectorDailyCap, "reflectorDailyCap", 5),
    recipeBudget: num(r.recipeBudget, "recipeBudget", 30),
    azCmd: strList(r.azCmd, "azCmd", ["az"]),
    settingSources: r.settingSources === undefined ? "" : strAllowEmpty(r.settingSources, "settingSources"),
    strictMcpConfig: bool(r.strictMcpConfig, "strictMcpConfig", true),
    pollSeconds: num(r.pollSeconds, "pollSeconds", 300),
    claudeCmd,
    model: r.model === undefined ? undefined : str(r.model, "model"),
    workerPermissionMode: str(r.workerPermissionMode, "workerPermissionMode", "dontAsk"),
    reviewPermissionMode: str(r.reviewPermissionMode, "reviewPermissionMode", "dontAsk"),
    workerTimeoutMinutes: num(r.workerTimeoutMinutes, "workerTimeoutMinutes", 45),
    checkTimeoutMinutes: num(r.checkTimeoutMinutes, "checkTimeoutMinutes", 15),
    maxRounds: num(r.maxRounds, "maxRounds", 3),
    maxBudgetUsd: r.maxBudgetUsd === undefined ? undefined : num(r.maxBudgetUsd, "maxBudgetUsd", 1),
    allowedTools: strList(r.allowedTools, "allowedTools", DEFAULT_ALLOWED_TOOLS),
    disallowedTools: strList(r.disallowedTools, "disallowedTools", DEFAULT_DISALLOWED_TOOLS),
    reviewAllowedTools: strList(r.reviewAllowedTools, "reviewAllowedTools", DEFAULT_REVIEW_TOOLS),
    openPr: bool(r.openPr, "openPr", true),
    fetchBeforeBranch: bool(r.fetchBeforeBranch, "fetchBeforeBranch", true),
    ado: adoSettings(r.ado, "ado"),
    teamsWebhook: r.teamsWebhook ? str(r.teamsWebhook, "teamsWebhook") : undefined,
    weeklyStatsDay: weekday(r.weeklyStatsDay, "weeklyStatsDay"),
    triage: bool(r.triage, "triage", true),
    triageIntervalMinutes: num(r.triageIntervalMinutes, "triageIntervalMinutes", 60),
    morningDigestHour: hour(r.morningDigestHour, "morningDigestHour"),
  };
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`config: cannot read ${path} (run "chief init" first)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config: ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw, resolve(path, ".."));
}
