import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
}

export interface Lanes {
  backlog: string;
  ready: string;
  cooking: string;
  pass: string;
  blocked: string;
  served: string;
}

export interface Config {
  boardPath: string;
  repos: Record<string, RepoConfig>;
  defaultRepo?: string;
  lanes: Lanes;
  stateFile: string;
  worktreesDir: string;
  digestDir: string;
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

function num(v: unknown, key: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new ConfigError(`config: "${key}" must be a positive number`);
  }
  return v;
}

function strList(v: unknown, key: string, fallback: string[]): string[] {
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ConfigError(`config: "${key}" must be an array of strings`);
  }
  return v as string[];
}

function bool(v: unknown, key: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new ConfigError(`config: "${key}" must be true or false`);
  return v;
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

  const adoRaw = (r.ado ?? {}) as Raw;
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
    ado: {
      org: adoRaw.org === undefined ? undefined : str(adoRaw.org, "ado.org"),
      project: adoRaw.project === undefined ? undefined : str(adoRaw.project, "ado.project"),
    },
    teamsWebhook: r.teamsWebhook ? str(r.teamsWebhook, "teamsWebhook") : undefined,
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
