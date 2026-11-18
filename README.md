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

Other keys, with defaults in `src/config.ts`: `runsDir` (run logs; default `runs/` next to the board), `tracesDir` (raw transcripts; default `~/.local/state/chief/traces`), `ledgerFile` (one JSON line per attempt and PR outcome, read by `chief stats`; default `~/.local/state/chief/ledger.jsonl`), `recipesFile` (default `~/.local/state/chief/recipes.json`), `learnedFile` (allowlist entries from approved `allow-tool` recipes; default `~/.config/chief/learned.json`), `reflector` (default `true`), `reflectorDailyCap` (default `5`), `recipeBudget` (default `30`), `azCmd` (default `["az"]`), `weeklyStatsDay` (weekday the weekly stats table goes into the digest, 0 = Sunday … 6 = Saturday; default `1`, Monday; `false` turns it off), `morningDigestHour` (0–23, default `8`; `false` turns the morning summary off), `triage` (default `true`), `triageIntervalMinutes` (default `60`), `settingSources` (default `""`, see Security model), `strictMcpConfig` (default `true`), `lanes` (rename lanes; matching ignores emoji and case), `allowedTools` / `disallowedTools` / `reviewAllowedTools`, `workerPermissionMode` / `reviewPermissionMode` (default `dontAsk`: anything not allowlisted is refused, never prompted), `stateFile`, `worktreesDir`, `fetchBeforeBranch`, `claudeCmd`.

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
- When a card's PR is merged, Chief moves it to **Served** and removes its worktree and local `chief/` branch. Blocked and Pass cards keep theirs, so a retry continues where it stopped.
- Moving a Blocked card back to Ready retries it on the same branch. The worker is told why the last attempt stopped and which commits it already made. If only the PR step failed and the branch hasn't changed, Chief skips the worker, checks and review and just opens the PR.
- When a check fails, Chief runs it once on the base commit. If it fails there too, the card is blocked straight away (category `environment`) instead of spending fix rounds on something the card didn't break. A fix round that adds no new commits also ends the run.

### Backlog triage

When nothing is Ready, Chief scores Backlog cards it hasn't scored yet, at most once an hour, in one cheap batched call (up to 10 cards, no tools: card text plus each repo's `CLAUDE.md` only):

```markdown
- [ ] Add retry to the export job #repo/api<br>🤖 📊 RICE 4.8 · R4 I2 C60% E1d · 🟡 yellow · touches every nightly export
```

RICE = reach (1–10) × impact (0.25–3) × confidence (50–100%) ÷ effort (days). Blast radius uses the reviewer's 🟢/🟡/🔴 scale. A card without a `#repo/` tag gets `suggest repo <name>` when one clearly fits. It is advisory only: cards never move and nothing is cooked. To re-score a card, delete its `🤖` line; `chief triage --all` re-scores the whole Backlog. Turn it off with `"triage": false`.

### Morning summary

From `morningDigestHour` (default 8) once a day, Chief sends one notification (Teams, or the desktop) and adds it to the digest: yesterday's runs, merges, your edits and cost; what is waiting at the Pass and in Blocked; recipes to review. On the weekly-stats day it adds one line for the week (first-pass rate against the week before). Nothing is sent on a quiet day. `chief morning` sends it now.

### Stacking cards: `#base/`

By default a card starts from `origin/<defaultBranch>` and its PR targets that branch. To build on work that isn't merged yet, tag the card:

```markdown
- [ ] Add the export endpoint #repo/nex-ts #base/chief-9c671b     ← on top of that card's branch
- [ ] Fix the importer #repo/nex-ts #base/feature/releases        ← on top of any branch
```

The card's branch starts from that branch (fetched from origin, or the local branch if it isn't pushed), and its draft PR targets it, so the PR shows only this card's changes. Several cards can share the same base. Once the base merges, retarget the stacked PR to the default branch in Azure DevOps. A `#base/chief-<id>` that Chief has no branch for, or a branch that doesn't exist, sends the card to Blocked. The PR step needs the base branch on origin.

### Teams notifications

In Teams: channel → **Workflows** → *Post to a channel when a webhook request is received*. Paste the URL into `teamsWebhook` and test with `chief doctor --notify`. If IT blocks Workflows, leave it empty and you'll get macOS notifications. The daily digest is always written either way.

## Traceability

Every card gets a run log, `runs/chief-<id>.md` next to the board, linked from the card as `run log`. It is rewritten after every step, so you can watch a card while it cooks. Per round it shows:

- **Worker / Reviewer:** duration, turns, cost, model, session id, then every tool call in order: ✓/✗, the tool, the command or file, and the first line of the error when it failed. Allowlist denials are listed separately.
- **Chief's checks:** each command, its exit code, and the end of the output when it failed.
- **Review verdict:** approve / changes, blast radius and findings.
- **Outcome:** the PR, or why the card was blocked.

Cooking the same card again adds a new attempt at the top and keeps the earlier ones. The raw stream-json transcript of every call is kept in `tracesDir/<id>/`, and the PR description gets an **Agent activity** section (files edited, commands run, denials per round) for reviewers who can't see your vault.

## Recipe book: Chief learns from its own runs

When a card goes badly, Chief asks a fresh, read-only Claude session what single rule would have prevented it. That covers more than one round, a Blocked card (for a work reason, not an outage), an allowlist denial, or an edit to rule files. A clean one-round pass costs nothing extra, and there are at most `reflectorDailyCap` (default 5) reflections a day.

It also learns from what happens after the PR, which is the strongest signal it gets:

- **Your corrections.** Chief remembers the commit it pushed. When the PR completes, it compares that with the PR's final source commit (`lastMergeSourceCommit`). If you pushed fixes, Chief saves the diff (`tracesDir/<id>/correction.diff`), marks the Served card `✏️ you edited N files`, and asks the reflector which rule would have made Chief write it your way. Only your own commits on the branch count, so merging the target branch in to resolve conflicts doesn't. While a PR is open, Chief fetches its branch on each check, so your fixes are local even if ADO deletes the branch on merge.
- **Reverts.** For 14 days after a merge, Chief watches the target branch for a commit that reverts it (`git revert`'s "This reverts commit …", or an ADO "Revert '<title>'" PR). The card gets `↩️ reverted`, you get a notification, and the reflector looks for what a rule could have caught.
- **Abandoned PRs** go to the reflector too. It proposes nothing if the reason was outside the work.
- **Rule budget.** Once a repo's `## Chief recipes` section reaches `recipeBudget` rules (default 30), new rules for that file come with a warning, and the reflector is told to propose only merges or replacements.

`chief stats` and the weekly digest count corrections, reverts and proposed recipes.

The reflector proposes up to 2 rules, preferring the most mechanical one that works:

| Kind | Card label | When you approve it |
|---|---|---|
| `lint-card` | `📖 lint:` | Chief cooks it as a normal card: the worker adds a lint rule, test or script that enforces the rule |
| `claude-rule` | `📖 CLAUDE.md:` | one line under `## Chief recipes` in the repo's CLAUDE.md, as a draft PR |
| `review-rule` | `📖 REVIEW.md:` | one line under `## Chief recipes` in REVIEW.md, as a draft PR |
| `allow-tool` | `📖 allow:` | added to `learned.json` (local, per repo), so workers may run that command from the next card on |

Proposals appear as cards in the **Recipes** lane (Chief adds the lane if your board doesn't have one), each with its reason and evidence.

- **Approve:** move the card to Ready. You can edit the rule text on the card first; Chief applies what the card says.
- **Reject:** check it off or delete the card. Chief remembers the rejection and never proposes the same rule again.
- Rules reach the repo only through PRs you merge. Nothing the reflector writes reaches a worker before you approve it.
- `allow-tool` proposals are filtered before they reach the board, and checked again when applied and every time they're loaded. Anything that overlaps the denied tools, uses shell metacharacters, runs a shell or inline code (`bash`, `sudo`, `node -e` …), or is a bare tool prefix (`Bash(npm:*)`, `Bash(git:*)`) is dropped.

```bash
chief recipes [--repo api]        # the recipe book: proposed / applied / merged / rejected
chief recipes revert r-1a2b3c     # undo an allow-tool; for a rule, tells you which PR to revert
```

## Security model

- Workers run with `--permission-mode dontAsk` and an explicit allowlist. `git push`, `git remote`, `az`, `curl`, `wget`, WebFetch and WebSearch are always denied. Only Chief pushes.
- Chief's allowlist is the only thing that grants permissions. Workers and the reviewer run with `--setting-sources ""` and `--strict-mcp-config`, so the allow rules you approved interactively (for example `Bash(pnpm *)` in a repo's `.claude/settings.local.json`), your hooks, plugins and MCP servers don't apply. Managed (org) settings still do. Put the extra commands a repo needs in its `allowedTools`; the worker's brief lists them.
- The allowlist limits which commands run, not what they do: an allowed test command that installs dependencies (`uv run`, `npm test` with a pre-step) can still reach the network.
- The reviewer gets read-only tools, and reads `REVIEW.md` from the target branch, never from the worker's worktree. A change that touches `REVIEW.md`, `CLAUDE.md` or `.claude/` anywhere is marked 🔴 with a note, so a worker can't rewrite the rules it's judged by without you seeing it.
- PRs are always drafts. There is no merge code path, so use ADO branch policies to require your approval.
- Everything (board, state, worktrees, logs) stays on the work machine.
- When the worker needs a command it isn't allowed, that shows up on the Blocked card. Add it to the repo's `allowedTools` only if you're happy for it to run unattended (or approve the reflector's `allow-tool` recipe, which is vetted the same way).
- The reflector reads run logs, which contain untrusted text (code, test output, card text). Its proposals are only data until you approve a card, and it has read-only tools.

## Day to day

```bash
chief status                      # lane counts + recent runs
chief stats [--repo api] [--weeks 4]  # first-pass rate, mean rounds, why cards got blocked, cost
chief stats --digest              # write last week's stats table into today's digest now (the daemon does it every Monday)
chief recipes                     # rules Chief proposed from its own runs (see Recipe book)
chief triage [--all]              # score new Backlog cards now (--all re-scores every one)
chief morning                     # send the morning summary now
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

- Several stations: per-repo concurrency and rules
- Recipe book R4: replay past cards to test a rule before you approve it; skill proposals
