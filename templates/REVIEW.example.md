# REVIEW.md: what the reviewer at the pass should care about in this repo

Copy this into the root of each repo Chief works on and edit it. Code owners write it.

## What failure looks like here
- (e.g.) Breaking the public API of `src/api/` without a version bump
- (e.g.) Queries without tenant filtering

## Always flag
- Missing or weak acceptance test for the behaviour the card asks for
- Secrets, tokens, or connection strings in code
- Changes to CI, deploy, or infra files (these are always red)

## Don't bother with
- Formatting or naming nits that the linter would catch
- Generated files: `dist/`, `*.lock`

## Evidence
Every finding needs `path:line` and one sentence on why it matters.
