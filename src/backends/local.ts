import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import type {
  Backend,
  BackendCallbacks,
  BackendHandle,
  BackendStartSpec,
} from "../core/types.ts";

/** Process groups still alive, killed synchronously if the host process exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

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

/**
 * Runs each job as a detached child process (its own process group) with
 * stdout and stderr appended straight to the log file. POSIX only.
 */
export class LocalBackend implements Backend {
  readonly name = "local";
  private readonly shell: string;

  constructor(options: { shell?: string } = {}) {
    this.shell = options.shell ?? resolveShell();
  }

  isAvailable(): boolean {
    return process.platform !== "win32";
  }

  start(spec: BackendStartSpec, callbacks: BackendCallbacks): Promise<BackendHandle> {
    installExitHook();

    return new Promise((resolve, reject) => {
      const fd = openSync(spec.logFile, "a");
      let settled = false;
      let exited = false;

      const child = spawn(this.shell, ["-c", spec.command], {
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
          callbacks.onExit({ exitCode: null, signal: null, error: err.message });
        }
      });

      child.once("spawn", () => {
        settled = true;
        // The child has its own copy of the descriptor.
        closeFd();
        const pgid = child.pid!;
        liveGroups.add(pgid);

        child.once("exit", (code, signal) => {
          if (exited) return;
          exited = true;
          liveGroups.delete(pgid);
          callbacks.onExit({ exitCode: code, signal: signal ?? null });
        });

        resolve({
          pid: pgid,
          async signal(sig) {
            signalGroup(pgid, sig);
          },
          async dispose() {
            // Leftover processes of the group (e.g. `cmd &`): make sure they go.
            signalGroup(pgid, "SIGKILL");
          },
        });
      });
    });
  }
}
