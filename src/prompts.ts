import type { RepoConfig } from "./config.js";

export const REVIEW_MARKER = "You are the REVIEWER AT THE PASS";

export interface Brief {
  title: string;
  notes: string[];
  repo: RepoConfig;
}

function checksLine(repo: RepoConfig): string {
  const cmds = [repo.testCmd, repo.lintCmd].filter(Boolean);
  return cmds.length ? cmds.map((c) => `\`${c}\``).join(" and ") : "the project's own test/lint commands";
}

export function workerPrompt(brief: Brief, feedback?: string): string {
  const notes = brief.notes.length ? brief.notes.map((n) => `- ${n}`).join("\n") : "(none)";
  return `You are a line cook in an automated software kitchen. Complete exactly one card in the current git worktree (repo: ${brief.repo.name}). Nobody is watching live; Chief will check your proof.

CARD: ${brief.title}
NOTES:
${notes}

Rules:
1. Read the surrounding code first and follow the existing style and conventions (see CLAUDE.md if present).
2. Write or identify an ACCEPTANCE TEST that fails before your change and passes after it.
3. Make the smallest change that satisfies the card. No unrelated refactors, no new dependencies, no CI/deploy config changes.
4. Run ${checksLine(brief.repo)} and make them pass. Shell access is a strict allowlist: run each check exactly as written, as its own command (no $(...), heredocs, pipes or chained variations). If a command is denied, don't retry variations; carry on without it and mention it in your summary.
5. Commit your work (git add, git commit) with a message in this repo's convention: match the style of \`git log\` and any commitlint or commit-msg hook, and if a hook rejects the message, fix it and commit again. Never push, open PRs, or change remotes.
6. If the card is ambiguous, unsafe, or impossible, make no changes and reply with a first line of "BLOCKED: <your question>".

Finish with a short summary: what changed, which acceptance test proves it, and how to revert.${
    feedback ? `\n\nThis card was sent back before. Fix this feedback first:\n${feedback}` : ""
  }`;
}

export function fixPrompt(feedback: string): string {
  return `The pass sent your dish back. Address every point below, re-run the checks, and commit the fixes. Do not push.

${feedback}

Finish with an updated short summary.`;
}

export function reviewPrompt(title: string, diff: string, reviewMd?: string): string {
  return `${REVIEW_MARKER}: a strict code reviewer with a fresh context. Review this change for the card "${title}". You may read files in the repo for context. Do not modify anything.
${reviewMd ? `\nThis repo's review guidelines (REVIEW.md):\n${reviewMd}\n` : ""}
Look for: correctness bugs, a missing or weak acceptance test, security problems, and scope creep beyond the card.
Rate the blast radius (how much breaks if this is wrong):
- green: docs, copy, tests, isolated low-risk code
- yellow: ordinary product code
- red: auth, payments, data migrations, CI/deploy, security-sensitive paths

Approve unless you find an Important issue; nits alone never block.
Reply with ONLY a JSON object, no prose:
{"verdict": "approve" | "changes", "blast": "green" | "yellow" | "red", "findings": ["path:line - issue", "..."]}

DIFF:
\`\`\`diff
${diff}
\`\`\``;
}
