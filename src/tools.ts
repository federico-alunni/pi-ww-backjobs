import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JobManager } from "./job-manager.ts";
import { formatElapsed } from "./widget.ts";

export function registerBackgroundTools(pi: ExtensionAPI, manager: JobManager): void {
  // ── background_run ──
  pi.registerTool({
    name: "background_run",
    description:
      "Run a long-running command in a background terminal (Herdr tab or split) without blocking the conversation. " +
      "Use this for dev servers, build tasks, test watchers, docker containers, or any background operations. " +
      "The user will see the job in the Pi widget and can open the terminal in a tab at any time.",
    parameters: Type.Object({
      command: Type.String({
        description: "The shell command to execute in background",
      }),
      name: Type.Optional(
        Type.String({
          description: "Short descriptive name for the task (e.g. 'dev-server', 'vitest --watch')",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory for the process (defaults to current cwd)",
        }),
      ),
      placement: Type.Optional(
        Type.Union([Type.Literal("tab"), Type.Literal("split")], {
          description:
            "Where to place the terminal: 'tab' (default, clean background tab) or 'split' (side pane)",
        }),
      ),
    }),
    async execute(_callId, args) {
      try {
        const job = await manager.startJob({
          command: args.command,
          name: args.name,
          cwd: args.cwd,
          placement: args.placement,
        });

        const targetDesc =
          job.placement === "tab"
            ? `dedicated tab "${job.tabLabel}" (pane ${job.paneId})`
            : `split pane ${job.paneId}`;

        return {
          content: [
            {
              type: "text",
              text:
                `Successfully started background job [${job.id}] "${job.name}".\n` +
                `Running in ${targetDesc}.\n` +
                `Status: running (CWD: ${job.cwd}).\n` +
                `The user can see it in the status widget and open its terminal tab anytime via /bg or Ctrl+B.`,
            },
          ],
          details: { job },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to launch background job: ${err.message || String(err)}`,
            },
          ],
          isError: true,
          details: { error: String(err) },
        };
      }
    },
  });

  // ── background_list ──
  pi.registerTool({
    name: "background_list",
    description:
      "List all active and recent background terminal operations managed by ww-backgrounds.",
    parameters: Type.Object({}),
    async execute() {
      const jobs = manager.getAllJobs();
      if (jobs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No background operations currently running or recently finished.",
            },
          ],
          details: { jobs: [] },
        };
      }

      const rows = jobs.map((j) => {
        const duration = formatElapsed(j.startedAt, j.endedAt);
        const exitInfo = j.exitCode !== undefined && j.exitCode !== null ? ` (exit ${j.exitCode})` : "";
        const target = j.placement === "tab" ? `tab ${j.tabLabel}` : `pane ${j.paneId}`;
        return `- [${j.id}] "${j.name}" (${j.status}${exitInfo}) | ${target} | Duration: ${duration} | Command: "${j.command}"`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Current background operations:\n${rows.join("\n")}`,
          },
        ],
        details: { jobs },
      };
    },
  });

  // ── background_read ──
  pi.registerTool({
    name: "background_read",
    description:
      "Read recent terminal output from a background operation without interrupting it.",
    parameters: Type.Object({
      jobId: Type.String({
        description: "The ID of the background job (e.g. 'bg-1')",
      }),
      lines: Type.Optional(
        Type.Number({
          description: "Number of lines of recent output to fetch (default: 50)",
        }),
      ),
    }),
    async execute(_callId, args) {
      try {
        const output = await manager.readOutput(args.jobId, args.lines ?? 50);
        return {
          content: [
            {
              type: "text",
              text:
                output.trim().length > 0
                  ? output
                  : `(No output recorded yet for job ${args.jobId})`,
            },
          ],
          details: { jobId: args.jobId },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading output for ${args.jobId}: ${err.message || String(err)}`,
            },
          ],
          isError: true,
          details: { error: String(err) },
        };
      }
    },
  });

  // ── background_stop ──
  pi.registerTool({
    name: "background_stop",
    description:
      "Send an interrupt (Ctrl+C) to a running background operation to stop it.",
    parameters: Type.Object({
      jobId: Type.String({
        description: "The ID of the background job to stop (e.g. 'bg-1')",
      }),
    }),
    async execute(_callId, args) {
      try {
        const ok = await manager.stopJob(args.jobId);
        if (!ok) {
          return {
            content: [{ type: "text", text: `Job "${args.jobId}" not found.` }],
            isError: true,
            details: { jobId: args.jobId },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Sent interrupt signal to background job [${args.jobId}].`,
            },
          ],
          details: { jobId: args.jobId },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to stop job ${args.jobId}: ${err.message || String(err)}`,
            },
          ],
          isError: true,
          details: { error: String(err) },
        };
      }
    },
  });
}
