# Chief

An always-on local "head chef" for your code. Chief watches an **Obsidian Kanban board** in your vault. When you move a card to **Ready**, Chief hands it to a **headless Claude Code** worker (`claude -p`, billed to whatever seat the CLI is logged into) in its own git worktree. It runs the tests itself, has a second fresh Claude session review the diff, and opens a **draft Azure DevOps PR**. Then it moves the card to **Pass** and pings you (Teams, or a desktop notification).

Chief never writes code itself and never merges.

```
 Backlog ──(you)──► Ready ──► Cooking ──► Pass ──(you merge)──► Served
                                 │
                                 └──► Blocked (question / failed checks / review didn't converge)
```

## How a card is cooked

1. **Claim:** the first unchecked card in Ready gets a `#chief-xxxxxx` id and moves to Cooking.
2. **Worktree:** a new branch `chief/<id>-<slug>` from `origin/<defaultBranch>` in `~/.local/state/chief/worktrees/`.
3. **Worker:** `claude -p` with a brief that asks for an acceptance test first and the smallest change. It runs under a strict tool allowlist: no push, no `az`, no network.
4. **Proof:** Chief commits the work and runs the repo's `testCmd`/`lintCmd` **itself**. Failures go back to the worker.
5. **Review:** a fresh `claude -p` with read-only tools reviews the diff (plus `REVIEW.md` if the repo has one) and returns approve/changes plus a blast radius of 🟢/🟡/🔴. Findings go back to the worker's session.
6. **Round cap:** after `maxRounds` (default 3) without approval, the card moves to Blocked.
7. **Draft PR:** `git push` + `az repos pr create --draft` with Summary / Testing / Risk / How to revert sections. The card moves to Pass and you're notified.
8. **Served:** when the PR is completed in Azure DevOps, the card moves to Served (checked every 10 min).

If a worker hits something it can't decide, it replies `BLOCKED: <question>`. The question shows up on the card, along with any commands the allowlist denied.

## Requirements (work Mac)

- Node **22+** (`node --version`)
- Claude Code, logged in with your enterprise account (`claude --version`)
- git with your identity set
- Azure CLI + DevOps extension: `brew install azure-cli && az extension add --name azure-devops`, then `az login`
- Optional: `brew install terminal-notifier` (nicer notifications than `osascript`)
- Obsidian with the **Kanban** community plugin in your work vault

> Check with your org that unattended headless use of the enterprise seat is allowed. `chief doctor --smoke` tells you whether `claude -p` works on that machine under your managed settings.

## Setup

```bash
# 1. Get the code onto the work Mac (git clone, or unzip the archive), then:
cd chief && npm install && npm run build

# 2. Create config + a board inside your work vault
node dist/cli.js init --board ~/path/to/WorkVault/Chief/board.md

# 3. Edit ~/.config/chief/config.json (see below), then check everything
node dist/cli.js doctor --smoke --notify

# 4. Cook one card by hand first (Phase 1)
node dist/cli.js run --card "part of the card title"

# 5. Turn it on (launchd agent; starts at login, restarts on crash, keeps the Mac awake)
scripts/launchd.sh install
tail -f ~/Library/Logs/chief/chief.log
```

`npm link` puts `chief` on your PATH if you'd rather not type `node dist/cli.js`.

## Config (`~/.config/chief/config.json`)

```jsonc
{
  "boardPath": "~/WorkVault/Chief/board.md",
  "digestDir": "~/WorkVault/Chief/digests",      // daily log, readable in Obsidian
  "defaultRepo": "my-service",                     // used when a card has no #repo/<name> tag
  "repos": {
    "my-service": {
      "path": "~/code/my-service",
      "defaultBranch": "main",
      "testCmd": "npm test",                       // Chief runs this; the worker may too
      "lintCmd": "npm run lint",
      "adoRepository": "my-service",               // ADO repo name, if different from the key
      "allowedTools": ["Bash(npm run build:*)"]    // extra commands the worker may run here
    }
  },
  "ado": { "org": "https://dev.azure.com/your-org", "project": "YourProject" },
  "teamsWebhook": "",                              // Teams Workflows webhook URL; empty = desktop notifications
  "openPr": true,                                  // false = stop at a local branch (good for a dry run)
  "pollSeconds": 300,
  "maxRounds": 3,
  "workerTimeoutMinutes": 45,
  "model": "sonnet",                               // optional; omit to use the CLI default
  "maxBudgetUsd": 5                                // optional per-call cap (only if your seat reports cost)
}
```

Each repo can also set `"ado": { "org", "project" }` when it lives in a different Azure DevOps org or project than the top-level `ado`.

Other keys, with defaults in `src/config.ts`: `runsDir` (run logs; default `runs/` next to the board), `tracesDir` (raw transcripts; default `~/.local/state/chief/traces`), `settingSources` (default `""`, see Security model), `strictMcpConfig` (default `true`), `lanes` (rename lanes; matching ignores emoji and case), `allowedTools` / `disallowedTools` / `reviewAllowedTools`, `workerPermissionMode` / `reviewPermissionMode` (default `dontAsk`: anything not allowlisted is refused, never prompted), `stateFile`, `worktreesDir`, `fetchBeforeBranch`, `claudeCmd`.

## The board

The Kanban plugin stores the board as plain markdown, which is what Chief reads and writes:

```markdown
## Backlog
- [ ] Add retry to the export job #repo/api

## Ready
- [ ] Fix date parsing in the report #repo/web
	Use the user's locale, not the server's      ← indented lines are notes for the worker
```

- Chief only ever takes cards from **Ready** (or one you name with `chief run --card`).
- Chief owns only the text after `<br>🤖` on a card. Your title and notes are never rewritten.
- If you edit the board while Chief is writing, Chief notices the file changed, re-reads, and retries instead of overwriting you.

### Teams notifications

In Teams: channel → **Workflows** → *Post to a channel when a webhook request is received*. Paste the URL into `teamsWebhook` and test with `chief doctor --notify`. If IT blocks Workflows, leave it empty and you'll get macOS notifications. The daily digest is always written either way.

## Traceability

Every card gets a run log, `runs/chief-<id>.md` next to the board, linked from the card as `run log`. It is rewritten after every step, so you can watch a card while it cooks. Per round it shows:

- **Worker / Reviewer:** duration, turns, cost, model, session id, then every tool call in order: ✓/✗, the tool, the command or file, and the first line of the error when it failed. Allowlist denials are listed separately.
- **Chief's checks:** each command, its exit code, and the end of the output when it failed.
- **Review verdict:** approve / changes, blast radius and findings.
- **Outcome:** the PR, or why the card was blocked.

Cooking the same card again adds a new attempt at the top and keeps the earlier ones. The raw stream-json transcript of every call is kept in `tracesDir/<id>/`, and the PR description gets an **Agent activity** section (files edited, commands run, denials per round) for reviewers who can't see your vault.

## Security model

- Workers run with `--permission-mode dontAsk` and an explicit allowlist. `git push`, `git remote`, `az`, `curl`, `wget`, WebFetch and WebSearch are always denied. Only Chief pushes.
- Chief's allowlist is the only thing that grants permissions. Workers and the reviewer run with `--setting-sources ""` and `--strict-mcp-config`, so the allow rules you approved interactively (for example `Bash(pnpm *)` in a repo's `.claude/settings.local.json`), your hooks, plugins and MCP servers don't apply. Managed (org) settings still do. Put the extra commands a repo needs in its `allowedTools`; the worker's brief lists them.
- The allowlist limits which commands run, not what they do: an allowed test command that installs dependencies (`uv run`, `npm test` with a pre-step) can still reach the network.
- The reviewer gets read-only tools.
- PRs are always drafts. There is no merge code path, so use ADO branch policies to require your approval.
- Everything (board, state, worktrees, logs) stays on the work machine.
- When the worker needs a command it isn't allowed, that shows up on the Blocked card. Add it to the repo's `allowedTools` only if you're happy for it to run unattended.

## Day to day

```bash
chief status                      # lane counts + recent runs
chief run                         # cook the next Ready card now (no need to wait for the poll)
scripts/launchd.sh restart        # after editing config or pulling an update (run npm run build first)
scripts/launchd.sh uninstall
```

Each repo can have a `REVIEW.md` (see `templates/REVIEW.example.md`) telling the reviewer what failure looks like there. Whenever you have to correct Chief's output, move that fix up the stack: code first, then a lint rule, then CLAUDE.md / REVIEW.md. Review is the last line of defence.

## Development

```bash
npm test          # vitest; uses tests/fixtures/fake-claude.mjs, no real Claude calls
npm run typecheck
npm run build
```

## Roadmap

- Backlog triage (RICE + blast radius annotations on Backlog cards)
- Morning digest notification
- Several stations: per-repo concurrency and rules
- Recipe book: record each correction as a rule
