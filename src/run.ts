import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Called with each stdout chunk as it arrives (e.g. to stream a trace to disk). */
  onStdout?: (chunk: string) => void;
}

// Process-group ids of children still running, so a SIGTERM to Chief can take them down too.
const active = new Set<number>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5000).unref();
}

export function killAll(): void {
  for (const pid of active) killGroup(pid);
}

/** Run a command in its own process group, feeding `input` on stdin. Never rejects. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid) active.add(pid);

    const finish = (code: number, extraErr = ""): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pid) active.delete(pid);
      resolve({ code, stdout, stderr: stderr + extraErr, timedOut });
    };

    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      opts.onStdout?.(chunk);
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => finish(127, String(err)));
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));

    if (opts.timeoutMs && pid) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(pid);
      }, opts.timeoutMs);
    }

    child.stdin.on("error", () => {
      // child exited before reading stdin (EPIPE); the exit code tells the story
    });
    child.stdin.end(opts.input ?? "");
  });
}

export function sh(command: string, cwd: string, timeoutMs?: number): Promise<RunResult> {
  return run("/bin/sh", ["-c", command], { cwd, timeoutMs });
}

export function git(args: string[], cwd: string): Promise<RunResult> {
  return run("git", args, { cwd });
}

export function tail(text: string, max = 3000): string {
  return text.length <= max ? text : "…" + text.slice(text.length - max);
}
