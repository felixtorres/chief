import type { RepoConfig } from "./config.js";
import { git, tail } from "./run.js";

/** What you changed on a Chief PR between Chief's last push and the merge. */
export interface Correction {
  files: string[];
  insertions: number;
  deletions: number;
  /** Subjects of your commits (merges excluded). */
  commits: string[];
  patch: string;
}

const MAX_PATCH_CHARS = 20_000;

async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  return (await git(["cat-file", "-e", `${sha}^{commit}`], cwd)).code === 0;
}

/**
 * Diff between the commit Chief pushed and the PR's final source commit. Only files touched by
 * your own commits on the branch count (first-parent, no merges), so merging the target branch
 * in to resolve conflicts doesn't read as a correction.
 *
 * Returns "none" when the PR merged exactly what Chief pushed, undefined when it can't tell
 * (no recorded push, or the final commit can't be fetched).
 */
export async function correctionDiff(
  repo: RepoConfig,
  run: { pushedHead?: string; branch?: string },
  sourceCommit?: string,
): Promise<Correction | "none" | undefined> {
  if (!run.pushedHead) return undefined;
  let final = sourceCommit;
  if (!final && run.branch) {
    if ((await git(["fetch", "origin", run.branch], repo.path)).code === 0) {
      const r = await git(["rev-parse", "FETCH_HEAD"], repo.path);
      if (r.code === 0) final = r.stdout.trim();
    }
  }
  if (!final) return undefined;
  if (final === run.pushedHead) return "none";
  for (const fetch of [[final], run.branch ? [run.branch] : []]) {
    if (await hasCommit(repo.path, final)) break;
    if (fetch.length) await git(["fetch", "origin", ...fetch], repo.path);
  }
  if (!(await hasCommit(repo.path, final)) || !(await hasCommit(repo.path, run.pushedHead))) return undefined;

  const range = `${run.pushedHead}..${final}`;
  const touched = await git(["log", "--first-parent", "--no-merges", "--name-only", "--format=", range], repo.path);
  if (touched.code !== 0) return undefined;
  const files = [...new Set(touched.stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
  if (!files.length) return "none";

  const subjects = await git(["log", "--first-parent", "--no-merges", "--format=%s", range], repo.path);
  const numstat = await git(["diff", "--numstat", run.pushedHead, final, "--", ...files], repo.path);
  const patch = await git(["diff", run.pushedHead, final, "--", ...files], repo.path);
  let insertions = 0;
  let deletions = 0;
  const changed: string[] = [];
  for (const line of numstat.stdout.split("\n")) {
    const [add, del, file] = line.split("\t");
    if (!file) continue;
    changed.push(file);
    insertions += Number(add) || 0;
    deletions += Number(del) || 0;
  }
  // Your commits may net out to nothing (a change you made and then undid).
  if (!changed.length) return "none";
  const text = patch.stdout;
  return {
    files: changed,
    insertions,
    deletions,
    commits: subjects.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    patch: text.length > MAX_PATCH_CHARS ? text.slice(0, MAX_PATCH_CHARS) + "\n… (diff truncated)" : text,
  };
}

export interface Revert {
  sha: string;
  subject: string;
}

/**
 * A commit on the target branch, after the merge, that reverts it: either `git revert`'s
 * "This reverts commit <merge>" or an Azure DevOps revert PR ("Revert '<title>'").
 */
export async function findRevert(
  repo: RepoConfig,
  target: string,
  merged: { mergeCommit?: string; title: string; since: string },
  fetched?: Set<string>,
): Promise<Revert | undefined> {
  const key = `${repo.path}\0${target}`;
  if (!fetched?.has(key)) {
    await git(["fetch", "origin", target], repo.path);
    fetched?.add(key);
  }
  const ref = (await git(["rev-parse", "--verify", "--quiet", `origin/${target}`], repo.path)).code === 0 ? `origin/${target}` : target;
  const log = await git(["log", ref, `--since=${merged.since}`, "--format=%H%x1f%s%x1f%b%x1e"], repo.path);
  if (log.code !== 0) return undefined;
  const short = merged.mergeCommit?.slice(0, 7);
  const title = merged.title.trim().toLowerCase();
  for (const entry of log.stdout.split("\x1e")) {
    const [sha, subject, body] = entry.trim().split("\x1f");
    if (!sha || !subject) continue;
    const text = `${subject}\n${body ?? ""}`;
    const bySha = short && new RegExp(`This reverts commit ${short}[0-9a-f]*`).test(text);
    const byTitle = title && /^(Merged PR \d+: )?Revert\b/i.test(subject) && text.toLowerCase().includes(title);
    if (bySha || byTitle) return { sha, subject: tail(subject, 200) };
  }
  return undefined;
}

/** Evidence block for the reflector: what you changed after Chief's PR was ready. */
export function correctionSignal(id: string, c: Correction): string {
  return [
    `After card chief-${id}'s PR was ready, YOU (the human) pushed changes to it before merging. This is your correction of Chief's work and the strongest evidence there is: find the rule that would have made Chief write it this way in the first place.`,
    `Files: ${c.files.join(", ")} (+${c.insertions} −${c.deletions})`,
    ...(c.commits.length ? [`Your commit messages: ${c.commits.map((s) => `"${s}"`).join("; ")}`] : []),
    "```diff",
    c.patch.trim(),
    "```",
  ].join("\n");
}

export function revertSignal(id: string, r: Revert, days: number): string {
  return `Card chief-${id}'s PR was merged and then REVERTED ${days} day(s) later by commit ${r.sha.slice(0, 10)} ("${r.subject}"). Something in it was wrong enough to undo. Use the run log to find what a rule could have caught; if nothing in the log explains the revert, propose nothing.`;
}

export function abandonedSignal(id: string, comment: string): string {
  return `Card chief-${id}'s PR was ABANDONED: the human closed it without merging, and wrote: "${comment}". Judge from that note and the run log whether the work itself was wrong (wrong approach, scope, or misread card). If the note says the work was superseded, merged elsewhere or no longer needed, the work was not wrong: propose nothing.`;
}
