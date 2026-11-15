import type { Config, RepoConfig } from "./config.js";
import { git, run, tail } from "./run.js";

export class AdoError extends Error {}

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

export async function pushBranch(worktree: string, branch: string): Promise<void> {
  const r = await git(["push", "-u", "origin", branch], worktree);
  if (r.code !== 0) throw new AdoError(`git push failed: ${tail(r.stderr, 500)}`);
}

export async function createDraftPr(
  cfg: Config,
  repo: RepoConfig,
  worktree: string,
  branch: string,
  title: string,
  description: string,
): Promise<{ id: number; url: string }> {
  const args = [
    "repos", "pr", "create",
    "--draft", "true",
    "--source-branch", branch,
    "--target-branch", repo.defaultBranch,
    "--repository", repo.adoRepository,
    "--title", title.slice(0, 400),
    "--description", ...description.split("\n").map((l) => (l === "" ? " " : l)),
    "--output", "json",
    ...orgArgs(cfg, repo),
  ];
  const r = await run("az", args, { cwd: worktree, timeoutMs: 120_000 });
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

/** "active" | "completed" | "abandoned", or undefined if Azure DevOps couldn't be reached. */
export async function prStatus(cfg: Config, repo: RepoConfig, id: number): Promise<string | undefined> {
  const { org } = adoFor(cfg, repo);
  const r = await run(
    "az",
    ["repos", "pr", "show", "--id", String(id), "--query", "status", "--output", "tsv", ...(org ? ["--org", org] : [])],
    { cwd: repo.path, timeoutMs: 60_000 },
  );
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}
