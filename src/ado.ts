import type { Config, RepoConfig } from "./config.js";
import { git, run, tail } from "./run.js";

export class AdoError extends Error {}

function az(cfg: Config, args: string[], opts: Parameters<typeof run>[2]) {
  return run(cfg.azCmd[0]!, [...cfg.azCmd.slice(1), ...args], opts);
}

/** The repo's own ado settings win over the top-level ones. */
export function adoFor(cfg: Config, repo: RepoConfig): { org?: string; project?: string } {
  return { org: repo.ado.org ?? cfg.ado.org, project: repo.ado.project ?? cfg.ado.project };
}

function orgArgs(cfg: Config, repo: RepoConfig): string[] {
  const { org, project } = adoFor(cfg, repo);
  const args: string[] = [];
  if (org) args.push("--org", org);
  if (project) args.push("--project", project);
  return args;
}

/**
 * A git hook that could not run at all, as opposed to one that ran and said no: its command
 * is missing. A recipe worktree has no installed dependencies (only a worker's test run
 * installs them), so hooks like nex-ts's `./node_modules/.bin/turbo run typecheck` or its
 * design-lint eslint fail this way on every recipe.
 */
export function hookCouldNotRun(output: string): boolean {
  return /command not found|No such file or directory|exit status 127|ENOENT/i.test(output);
}

/**
 * Push the branch. With `skipHooksThatCannotRun` (recipes only), a push stopped by a hook
 * that could not run is retried once with --no-verify; a hook that ran and refused still fails.
 */
export async function pushBranch(
  worktree: string,
  branch: string,
  env: Record<string, string> = {},
  opts: { skipHooksThatCannotRun?: boolean } = {},
): Promise<{ skippedHooks: boolean }> {
  const push = (extra: string[]) =>
    Object.keys(env).length
      ? run("git", ["push", ...extra, "-u", "origin", branch], { cwd: worktree, env: { ...process.env, ...env } })
      : git(["push", ...extra, "-u", "origin", branch], worktree);
  let r = await push([]);
  if (r.code === 0) return { skippedHooks: false };
  if (opts.skipHooksThatCannotRun && hookCouldNotRun(`${r.stdout}\n${r.stderr}`)) {
    r = await push(["--no-verify"]);
    if (r.code === 0) return { skippedHooks: true };
  }
  throw new AdoError(`git push failed: ${pushError(`${r.stdout}\n${r.stderr}`)}`);
}

/**
 * Say why a push failed in one line. Drops SSH's advisory banners (the "post-quantum key
 * exchange" warning), and when a git hook (lefthook) stopped the push, names the failed
 * step and the failing tests instead of the hook's whole log.
 */
export function pushError(output: string, max = 500): string {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.trimEnd());
  const kept = lines.filter((l) => l.trim() && !/^\*\* /.test(l.trim()));
  const hookFailed = kept.filter((l) => /^\s*🥊\s*\S/.test(l)).map((l) => l.replace(/^\s*🥊\s*/, "").replace(/\s*\([\d.]+ seconds?\)/, "").trim());
  const last = kept.filter((l) => /^(error|fatal|remote: error|!\s*\[rejected\])/i.test(l.trim())).map((l) => l.trim());
  if (hookFailed.length) {
    const fails = [...new Set(kept.filter((l) => /\bFAIL\b|Test timed out|Failed:\s/.test(l)).map((l) => l.replace(/\s+/g, " ").trim()))].slice(0, 5);
    const msg = `a git pre-push hook stopped it; failed step${hookFailed.length > 1 ? "s" : ""}: ${hookFailed.join(", ")}${fails.length ? `. ${fails.join("; ")}` : ""}${last.length ? `. ${last.at(-1)}` : ""}`;
    return msg.length > max ? msg.slice(0, max - 1) + "…" : msg;
  }
  return tail(kept.join(" ").replace(/\s+/g, " "), max);
}

/** Azure DevOps rejects PR descriptions longer than this. */
export const PR_DESCRIPTION_MAX = 4000;

/**
 * Fit a PR description under Azure DevOps' limit. az sends blank lines as " ", so count
 * them that way. Cuts at a line boundary and says so; the run log keeps the full story.
 */
export function fitDescription(description: string, max = PR_DESCRIPTION_MAX): string {
  const size = (s: string) => s.split("\n").map((l) => (l === "" ? " " : l)).join("\n").length;
  if (size(description) <= max) return description;
  const note = "\n\n_(Description shortened to fit Azure DevOps' 4000-character limit. The full run log is on the Chief host.)_";
  const lines = description.split("\n");
  while (lines.length && size(lines.join("\n") + note) > max) lines.pop();
  const kept = lines.join("\n");
  return size(kept + note) <= max ? kept + note : description.slice(0, max - 1) + "…";
}

export async function createDraftPr(
  cfg: Config,
  repo: RepoConfig,
  worktree: string,
  branch: string,
  target: string,
  title: string,
  description: string,
): Promise<{ id: number; url: string }> {
  const args = [
    "repos", "pr", "create",
    "--draft", "true",
    "--source-branch", branch,
    "--target-branch", target,
    "--repository", repo.adoRepository,
    "--title", title.slice(0, 400),
    "--description", ...fitDescription(description).split("\n").map((l) => (l === "" ? " " : l)),
    "--output", "json",
    ...orgArgs(cfg, repo),
  ];
  const r = await az(cfg, args, { cwd: worktree, timeoutMs: 120_000 });
  if (r.code !== 0) throw new AdoError(`az repos pr create failed: ${tail(r.stderr || r.stdout, 500)}`);
  let data: { pullRequestId?: number; repository?: { webUrl?: string } };
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new AdoError(`az repos pr create returned non-JSON: ${tail(r.stdout, 300)}`);
  }
  if (!data.pullRequestId) throw new AdoError("az repos pr create returned no pullRequestId");
  const web = data.repository?.webUrl ?? "";
  return { id: data.pullRequestId, url: web ? `${web}/pullrequest/${data.pullRequestId}` : "" };
}

/**
 * The active PR from `branch` into `target`, if there is one. Azure DevOps allows only one
 * active PR per source and target, so a card rerun after Pass must update it, not create
 * another. Undefined when there is none or the lookup failed (then create runs as before).
 */
export async function findActivePr(
  cfg: Config,
  repo: RepoConfig,
  worktree: string,
  branch: string,
  target: string,
): Promise<{ id: number; url: string } | undefined> {
  const args = [
    "repos", "pr", "list",
    "--source-branch", branch,
    "--target-branch", target,
    "--repository", repo.adoRepository,
    "--status", "active",
    "--output", "json",
    ...orgArgs(cfg, repo),
  ];
  const r = await az(cfg, args, { cwd: worktree, timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  try {
    const list = JSON.parse(r.stdout) as Array<{
      pullRequestId?: number;
      repository?: { webUrl?: string; name?: string; project?: { name?: string } };
    }>;
    const pr = Array.isArray(list) ? list.find((p) => p.pullRequestId) : undefined;
    if (!pr?.pullRequestId) return undefined;
    // `pr list` leaves out repository.webUrl (`pr create` and `pr show` include it), so
    // build the same <org>/<project>/_git/<repo> address from the fields it does return.
    const { org } = adoFor(cfg, repo);
    const repoName = pr.repository?.name;
    const project = pr.repository?.project?.name;
    const web =
      pr.repository?.webUrl ??
      (org && project && repoName ? `${org.replace(/\/+$/, "")}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}` : "");
    return { id: pr.pullRequestId, url: web ? `${web}/pullrequest/${pr.pullRequestId}` : "" };
  } catch {
    return undefined;
  }
}

/** Replace an existing PR's title and description (its commits come from the push). */
export async function updatePr(cfg: Config, repo: RepoConfig, worktree: string, id: number, title: string, description: string): Promise<void> {
  const { org } = adoFor(cfg, repo);
  const args = [
    "repos", "pr", "update",
    "--id", String(id),
    "--title", title.slice(0, 400),
    "--description", ...fitDescription(description).split("\n").map((l) => (l === "" ? " " : l)),
    "--output", "json",
    ...(org ? ["--org", org] : []),
  ];
  const r = await az(cfg, args, { cwd: worktree, timeoutMs: 120_000 });
  if (r.code !== 0) throw new AdoError(`az repos pr update failed: ${tail(r.stderr || r.stdout, 500)}`);
}

/**
 * Open a draft PR for `branch`, or update the one already open for it. The caller has pushed.
 * `updated` says which happened.
 */
export async function openOrUpdateDraftPr(
  cfg: Config,
  repo: RepoConfig,
  worktree: string,
  branch: string,
  target: string,
  title: string,
  description: string | ((updating: boolean) => string),
): Promise<{ id: number; url: string; updated: boolean }> {
  const text = (updating: boolean) => (typeof description === "function" ? description(updating) : description);
  const open = await findActivePr(cfg, repo, worktree, branch, target);
  if (open) {
    await updatePr(cfg, repo, worktree, open.id, title, text(true));
    return { ...open, updated: true };
  }
  return { ...(await createDraftPr(cfg, repo, worktree, branch, target, title, text(false))), updated: false };
}

export interface PrDetails {
  /** "active" | "completed" | "abandoned" */
  status: string;
  /** The PR's final source commit (what was merged, including anything you pushed). */
  sourceCommit?: string;
  /** The merge commit on the target branch. */
  mergeCommit?: string;
  closedDate?: string;
}

/** The PR's status and final commits, or undefined if Azure DevOps couldn't be reached. */
export async function prDetails(cfg: Config, repo: RepoConfig, id: number): Promise<PrDetails | undefined> {
  const { org } = adoFor(cfg, repo);
  const r = await az(cfg, ["repos", "pr", "show", "--id", String(id), "--output", "json", ...(org ? ["--org", org] : [])], { cwd: repo.path, timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  try {
    const d = JSON.parse(r.stdout) as {
      status?: string;
      lastMergeSourceCommit?: { commitId?: string };
      lastMergeCommit?: { commitId?: string };
      closedDate?: string;
    };
    if (!d.status) return undefined;
    return { status: d.status, sourceCommit: d.lastMergeSourceCommit?.commitId, mergeCommit: d.lastMergeCommit?.commitId, closedDate: d.closedDate };
  } catch {
    return undefined;
  }
}

/** "active" | "completed" | "abandoned", or undefined if Azure DevOps couldn't be reached. */
export async function prStatus(cfg: Config, repo: RepoConfig, id: number): Promise<string | undefined> {
  return (await prDetails(cfg, repo, id))?.status;
}
