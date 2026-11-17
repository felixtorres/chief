#!/usr/bin/env node
// Stand-in for the Azure CLI in tests. Only `repos pr show` is faked:
//   FAKE_AZ_PR   JSON printed for `az repos pr show` (default: an active PR)
//   FAKE_STATE   dir for an az.jsonl log of argv
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_STATE) appendFileSync(join(process.env.FAKE_STATE, "az.jsonl"), JSON.stringify({ args }) + "\n");
if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") {
  process.stdout.write(process.env.FAKE_AZ_PR ?? JSON.stringify({ status: "active" }));
  process.exit(0);
}
process.stderr.write(`fake az: unsupported ${args.join(" ")}`);
process.exit(2);
