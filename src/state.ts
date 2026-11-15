import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type RunStatus = "cooking" | "pass" | "blocked" | "served";
export type Blast = "green" | "yellow" | "red";

export interface RunRecord {
  id: string;
  title: string;
  repo: string;
  status: RunStatus;
  branch?: string;
  worktree?: string;
  prId?: number;
  prUrl?: string;
  rounds: number;
  blast?: Blast;
  reason?: string;
  summary?: string;
  startedAt: string;
  updatedAt: string;
}

/** Small JSON-file store. One Chief process owns it, so no locking beyond atomic rename. */
export class StateStore {
  private runs: Record<string, RunRecord> = {};

  constructor(private file: string) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { runs?: Record<string, RunRecord> };
      this.runs = parsed.runs ?? {};
    }
  }

  get(id: string): RunRecord | undefined {
    return this.runs[id];
  }

  upsert(patch: Partial<RunRecord> & { id: string }): RunRecord {
    const now = new Date().toISOString();
    const prev = this.runs[patch.id];
    const next: RunRecord = {
      title: "",
      repo: "",
      status: "cooking",
      rounds: 0,
      startedAt: now,
      ...prev,
      ...patch,
      updatedAt: now,
    };
    this.runs[patch.id] = next;
    this.save();
    return next;
  }

  byStatus(status: RunStatus): RunRecord[] {
    return Object.values(this.runs).filter((r) => r.status === status);
  }

  all(): RunRecord[] {
    return Object.values(this.runs).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ runs: this.runs }, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}
