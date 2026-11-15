import type { Config, RepoConfig } from "./config.js";
import { git, run, tail } from "./run.js";

export class AdoError extends Error {}

function orgArgs(cfg: Config): string[] {
  const args: string[] = [];
  if (cfg.ado.org) args.push("--org", cfg.ado.org);
  if (cfg.ado.project) args.push("--project", cfg.ado.project);
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
    ...orgArgs(cfg),
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
  const r = await run(
    "az",
    ["repos", "pr", "show", "--id", String(id), "--query", "status", "--output", "tsv", ...(cfg.ado.org ? ["--org", cfg.ado.org] : [])],
    { cwd: repo.path, timeoutMs: 60_000 },
  );
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}
