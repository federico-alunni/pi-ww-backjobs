import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closePane,
  closeTab,
  createBackgroundTab,
  createSplitPane,
  focusTab,
  getPane,
  getProcessInfo,
  isHerdrAvailable,
  movePaneToNewTab,
  readPane,
  renamePane,
  runInPane,
  sendKeys,
} from "./herdr.ts";
import type { BackgroundJob, BackgroundRunOptions } from "./types.ts";

export class JobManager {
  private jobs = new Map<string, BackgroundJob>();
  private counter = 0;
  private pollInterval?: NodeJS.Timeout;
  private listeners = new Set<(jobs: BackgroundJob[]) => void>();

  constructor() {
    this.startPolling();
  }

  onUpdate(listener: (jobs: BackgroundJob[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const list = this.getAllJobs();
    for (const listener of this.listeners) {
      try {
        listener(list);
      } catch (err) {
        console.error("ww-backgrounds listener error:", err);
      }
    }
  }

  getAllJobs(): BackgroundJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  getActiveJobs(): BackgroundJob[] {
    return this.getAllJobs().filter((j) => j.status === "running");
  }

  getJob(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  startPolling(intervalMs = 1000): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      void this.checkJobsStatus();
    }, intervalMs);
    this.pollInterval.unref?.();
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  async checkJobsStatus(): Promise<void> {
    let changed = false;

    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;

      // 1. Check status file
      if (existsSync(job.statusFile)) {
        try {
          const raw = readFileSync(job.statusFile, "utf8").trim();
          if (raw) {
            const data = JSON.parse(raw);
            if (data.status === "completed" || data.status === "failed" || data.status === "stopped") {
              job.status = data.status;
              job.exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
              job.endedAt = data.endedAt ?? Date.now();
              changed = true;
              continue;
            }
          }
        } catch {
          // File might be currently written to
        }
      }

      // 2. Check if Herdr pane still exists
      const pane = await getPane(job.paneId);
      if (!pane) {
        // Pane was closed manually by user
        job.status = "stopped";
        job.endedAt = Date.now();
        changed = true;
        continue;
      }

      // 3. Check process info: if foreground process group is idle/shell only
      const proc = await getProcessInfo(job.paneId);
      if (proc) {
        const fgProcs = proc.foreground_processes ?? [];
        // If there are no foreground processes or only the shell PID is foreground
        const shellPid = proc.shell_pid;
        const nonShellProcs = fgProcs.filter((p) => p.pid !== shellPid);

        // If command was launched > 2s ago and there are no active non-shell processes
        if (Date.now() - job.startedAt > 2000 && nonShellProcs.length === 0) {
          // The shell returned to prompt: the command is no longer running!
          let finalStatus: JobStatus = "completed";
          let finalExitCode: number | null = 0;

          if (existsSync(job.statusFile)) {
            try {
              const raw = readFileSync(job.statusFile, "utf8").trim();
              if (raw) {
                const data = JSON.parse(raw);
                if (data.status === "completed" || data.status === "failed" || data.status === "stopped") {
                  finalStatus = data.status;
                  finalExitCode = data.exitCode ?? (data.status === "failed" ? 1 : 0);
                } else {
                  // File still says "running", but processes are gone: it was interrupted (Ctrl+C / SIGINT)
                  finalStatus = "stopped";
                  finalExitCode = 130;
                }
              } else {
                finalStatus = "stopped";
                finalExitCode = 130;
              }
            } catch {
              finalStatus = "stopped";
              finalExitCode = 130;
            }
          } else {
            finalStatus = "completed";
            finalExitCode = 0;
          }

          job.status = finalStatus;
          job.exitCode = finalExitCode;
          job.endedAt = Date.now();
          changed = true;
        }
      }
    }

    if (changed) {
      this.notify();
    }
  }

  async startJob(options: BackgroundRunOptions): Promise<BackgroundJob> {
    if (!isHerdrAvailable()) {
      throw new Error(
        "Herdr is not available in the current environment (HERDR_ENV is not set).",
      );
    }

    const id = `bg-${++this.counter}`;
    const name = options.name?.trim() || options.command.trim().slice(0, 30);
    const cwd = options.cwd?.trim() || process.cwd();
    const placement = options.placement ?? "tab";

    const timestamp = Date.now();
    const statusFile = join(tmpdir(), `ww_${id}_${timestamp}.status.json`);
    const scriptFile = join(tmpdir(), `ww_${id}_${timestamp}.sh`);

    // Prepare runner shell script with signal trapping
    const scriptContent = `#!/bin/bash
STATUS_FILE=${JSON.stringify(statusFile)}
printf '{"status":"running","startedAt":%s}\\n' "$(date +%s)000" > "$STATUS_FILE"

_INTERRUPTED=0
trap '_INTERRUPTED=1; exit 130' INT
trap '_INTERRUPTED=1; exit 143' TERM

_cleanup() {
  _CODE=$?
  if [ -f "$STATUS_FILE.done" ]; then
    return
  fi
  touch "$STATUS_FILE.done"

  if [ $_INTERRUPTED -eq 1 ] || [ $_CODE -eq 130 ] || [ $_CODE -eq 143 ]; then
    _STATUS="stopped"
  elif [ $_CODE -eq 0 ]; then
    _STATUS="completed"
  else
    _STATUS="failed"
  fi
  printf '{"status":"%s","exitCode":%d,"endedAt":%s}\\n' "$_STATUS" "$_CODE" "$(date +%s)000" > "$STATUS_FILE"
}
trap _cleanup EXIT

echo "========================================================"
echo "⚡ ww-backgrounds [${id}]: ${name}"
echo "📁 CWD: ${cwd}"
echo "▶ Command: ${options.command}"
echo "========================================================"
echo ""

(
  cd ${JSON.stringify(cwd)} && ${options.command}
)
__CMD_EXIT=$?

echo ""
echo "--------------------------------------------------------"
if [ $__CMD_EXIT -eq 0 ]; then
  echo "✓ [${id}] Completed successfully (exit 0)"
else
  echo "✖ [${id}] Exited with code $__CMD_EXIT"
fi
echo "--------------------------------------------------------"

exit $__CMD_EXIT
`;

    writeFileSync(scriptFile, scriptContent, { mode: 0o755 });
    chmodSync(scriptFile, 0o755);

    let paneId: string;
    let tabId: string;
    let tabLabel: string;

    if (placement === "tab") {
      const tabRes = await createBackgroundTab({
        label: name,
        cwd,
        noFocus: true,
      });
      tabId = tabRes.tabId;
      paneId = tabRes.rootPaneId;
      tabLabel = tabRes.tabLabel;
      await renamePane(paneId, name);
    } else {
      const splitRes = await createSplitPane({
        direction: "right",
        cwd,
        noFocus: true,
      });
      paneId = splitRes.paneId;
      tabId = splitRes.tabId;
      tabLabel = name;
      await renamePane(paneId, name);
    }

    // Launch script in pane
    await runInPane(paneId, `bash ${JSON.stringify(scriptFile)}`);

    const job: BackgroundJob = {
      id,
      name,
      command: options.command,
      cwd,
      paneId,
      tabId,
      tabLabel,
      placement,
      status: "running",
      startedAt: Date.now(),
      statusFile,
      scriptFile,
    };

    this.jobs.set(id, job);
    this.notify();
    return job;
  }

  async stopJob(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.status === "running") {
      try {
        await sendKeys(job.paneId, "ctrl+c");
      } catch {}
      job.status = "stopped";
      job.endedAt = Date.now();
      this.notify();
    }
    return true;
  }

  async closeJobTerminal(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;

    try {
      if (job.placement === "tab") {
        await closeTab(job.tabId);
      } else {
        await closePane(job.paneId);
      }
    } catch {}

    this.jobs.delete(id);
    this.cleanJobFiles(job);
    this.notify();
    return true;
  }

  async focusJobTab(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.placement === "tab") {
      await focusTab(job.tabId);
      return true;
    }

    // If it was in a split pane, move it to a new tab with focus
    const res = await movePaneToNewTab(job.paneId, job.name, true);
    if (res.tabId) {
      job.tabId = res.tabId;
      job.placement = "tab";
      this.notify();
    }
    return true;
  }

  async readOutput(id: string, lines = 50): Promise<string> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Background job "${id}" not found.`);
    return readPane(job.paneId, lines);
  }

  private cleanJobFiles(job: BackgroundJob): void {
    try {
      if (existsSync(job.statusFile)) unlinkSync(job.statusFile);
    } catch {}
    try {
      if (existsSync(job.scriptFile)) unlinkSync(job.scriptFile);
    } catch {}
  }

  dispose(): void {
    this.stopPolling();
    this.listeners.clear();
    for (const job of this.jobs.values()) {
      this.cleanJobFiles(job);
    }
    this.jobs.clear();
  }
}

export const globalJobManager = new JobManager();
