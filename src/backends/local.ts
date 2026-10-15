import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import type {
  Backend,
  BackendCallbacks,
  BackendExit,
  BackendHandle,
  BackendReattachResult,
  BackendReattachSpec,
  BackendStartSpec,
} from "../core/types.ts";

/** Process groups still alive, killed synchronously if the host process exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
const REATTACH_POLL_MS = 500;

/**
 * Runs a durable command and records how it ended: `$1` shell, `$2` command,
 * `$3` exit file. The traps keep the wrapper alive when the group gets
 * SIGTERM/SIGINT/SIGHUP, so it can still write the status of the command
 * (which gets the signal too: handled traps are reset in children). The file
 * is written atomically (tmp + rename). Only SIGKILL of the wrapper leaves no
 * exit file. The wrapper's own stderr goes to /dev/null (no "Terminated"
 * reports of its own in the log); the command keeps the log as stderr.
 */
const DURABLE_WRAPPER = [
  'trap ":" TERM INT HUP',
  "exec 3>&2 2>/dev/null",
  '"$1" -c "$2" 2>&3 3>&-',
  "s=$?",
  'printf "%s\\n" "$s" > "$3.tmp" && mv -f "$3.tmp" "$3"',
  'exit "$s"',
].join("\n");

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const pgid of liveGroups) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
    }
  });
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err: any) {
    if (err?.code !== "ESRCH") throw err;
  }
}

export function resolveShell(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Start time of a process, as an opaque string, to tell a reused pid apart.
 * Linux: `starttime` from /proc (clock ticks since boot). Elsewhere: `ps -o lstart`.
 */
export function readProcessStart(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the command name, which may contain spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ? `linux:${fields[19]}` : undefined;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      // Fixed locale and zone: the same process must give the same string to any host.
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? `ps:${out}` : undefined;
  } catch {
    return undefined;
  }
}

/** Parse an exit file written by the durable wrapper. */
export function readExitFile(file: string): BackendExit | undefined {
  let raw: string;
  let endedAt: number;
  try {
    raw = readFileSync(file, "utf8").trim();
    endedAt = statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const status = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(status)) {
    return { exitCode: null, signal: null, error: `Unreadable exit file: ${JSON.stringify(raw)}`, endedAt };
  }
  if (status > 128) {
    const signal = Object.entries(osConstants.signals).find(([, n]) => n === status - 128)?.[0];
    if (signal) return { exitCode: null, signal, endedAt };
  }
  return { exitCode: status, signal: null, endedAt };
}

export interface LocalBackendOptions {
  shell?: string;
  /** Override for tests. */
  processStart?: (pid: number) => string | undefined;
  /** Override for tests. */
  reattachPollMs?: number;
}

/**
 * Runs each job as a detached child process (its own process group) with
 * stdout and stderr appended straight to the log file. POSIX only.
 *
 * Durable jobs run inside a small wrapper that writes the exit status to a
 * file, are not killed when the host exits, and can be found again by a
 * later host process with `reattach()`.
 */
export class LocalBackend implements Backend {
  readonly name = "local";
  private readonly shell: string;
  private readonly processStart: (pid: number) => string | undefined;
  private readonly reattachPollMs: number;

  constructor(options: LocalBackendOptions = {}) {
    this.shell = options.shell ?? resolveShell();
    this.processStart = options.processStart ?? readProcessStart;
    this.reattachPollMs = options.reattachPollMs ?? REATTACH_POLL_MS;
  }

  isAvailable(): boolean {
    return process.platform !== "win32";
  }

  start(spec: BackendStartSpec, callbacks: BackendCallbacks): Promise<BackendHandle> {
    const durable = spec.durable;
    if (!durable) installExitHook();

    return new Promise((resolve, reject) => {
      const fd = openSync(spec.logFile, "a");
      let settled = false;
      let exited = false;
      let detached = false;

      const args = durable
        ? ["-c", DURABLE_WRAPPER, "pi-ww-backjobs", this.shell, spec.command, durable.exitFile]
        : ["-c", spec.command];
      const child = spawn(this.shell, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        detached: true,
        stdio: ["ignore", fd, fd],
      });

      const closeFd = () => {
        try {
          closeSync(fd);
        } catch {}
      };

      child.once("error", (err) => {
        closeFd();
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        if (!exited) {
          exited = true;
          if (child.pid) liveGroups.delete(child.pid);
          if (!detached) callbacks.onExit({ exitCode: null, signal: null, error: err.message });
        }
      });

      child.once("spawn", () => {
        settled = true;
        // The child has its own copy of the descriptor.
        closeFd();
        const pgid = child.pid!;
        if (durable) child.unref();
        else liveGroups.add(pgid);

        child.once("exit", (code, signal) => {
          if (exited) return;
          exited = true;
          liveGroups.delete(pgid);
          if (detached) return;
          // The wrapper's file holds the command's own status.
          const recorded = durable ? readExitFile(durable.exitFile) : undefined;
          callbacks.onExit(recorded ?? { exitCode: code, signal: signal ?? null });
        });

        resolve({
          pid: pgid,
          processStart: durable ? this.processStart(pgid) : undefined,
          async signal(sig) {
            signalGroup(pgid, sig);
          },
          async dispose() {
            // Leftover processes of the group (e.g. `cmd &`): make sure they go.
            signalGroup(pgid, "SIGKILL");
          },
          detach() {
            detached = true;
          },
        });
      });
    });
  }

  async reattach(spec: BackendReattachSpec, callbacks: BackendCallbacks): Promise<BackendReattachResult> {
    const recorded = readExitFile(spec.exitFile);
    if (recorded) return { exit: recorded };

    const lost = (error: string): BackendReattachResult => ({
      exit: { exitCode: null, signal: null, lost: true, error },
    });
    const { pid } = spec;
    if (!pid) return lost("The process id was never recorded (the host stopped while starting the job)");
    if (!isProcessAlive(pid)) {
      // The wrapper may have written the file right before exiting.
      const late = readExitFile(spec.exitFile);
      return late ? { exit: late } : lost(`Process ${pid} is gone and left no exit status`);
    }
    if (!spec.processStart) return lost(`Cannot verify that process ${pid} is still the job (no start time recorded)`);
    if (this.processStart(pid) !== spec.processStart) {
      return lost(`Process ${pid} is gone; its pid now belongs to another process`);
    }

    let done = false;
    const finish = (exit: BackendExit) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      callbacks.onExit(exit);
    };
    const timer = setInterval(() => {
      const exit = readExitFile(spec.exitFile);
      if (exit) return finish(exit);
      if (isProcessAlive(pid)) return;
      finish(readExitFile(spec.exitFile) ?? { exitCode: null, signal: null, lost: true, error: `Process ${pid} is gone and left no exit status` });
    }, this.reattachPollMs);
    timer.unref?.();

    return {
      handle: {
        pid,
        processStart: spec.processStart,
        async signal(sig) {
          signalGroup(pid, sig);
        },
        async dispose() {
          clearInterval(timer);
          signalGroup(pid, "SIGKILL");
        },
        detach() {
          done = true;
          clearInterval(timer);
        },
      },
    };
  }
}
