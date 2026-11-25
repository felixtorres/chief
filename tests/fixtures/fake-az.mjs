#!/usr/bin/env node
// Stand-in for the Azure CLI in tests.
//   FAKE_AZ_PR       JSON printed for `az repos pr show` (default: an active PR)
//   FAKE_AZ_ACTIVE   JSON printed for `az repos pr list` (default: no active PRs)
//   `az repos pr create` answers PR 101; `az repos pr update` succeeds.
//   FAKE_AZ_THREADS  JSON printed for `az devops invoke` (PR threads; default: none)
//   FAKE_STATE       dir for an az.jsonl log of argv
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_STATE) appendFileSync(join(process.env.FAKE_STATE, "az.jsonl"), JSON.stringify({ args }) + "\n");
const [group, sub, verb] = args;
if (group === "repos" && sub === "pr") {
  if (verb === "show") {
    process.stdout.write(process.env.FAKE_AZ_PR ?? JSON.stringify({ status: "active" }));
    process.exit(0);
  }
  if (verb === "list") {
    process.stdout.write(process.env.FAKE_AZ_ACTIVE ?? "[]");
    process.exit(0);
  }
  if (verb === "create") {
    process.stdout.write(JSON.stringify({ pullRequestId: 101, repository: { webUrl: "https://ado.test/_git/demo" } }));
    process.exit(0);
  }
  if (verb === "update") {
    process.stdout.write("{}");
    process.exit(0);
  }
}
if (group === "devops" && sub === "invoke") {
  process.stdout.write(process.env.FAKE_AZ_THREADS ?? JSON.stringify({ value: [] }));
  process.exit(0);
}
process.stderr.write(`fake az: unsupported ${args.join(" ")}`);
process.exit(2);
