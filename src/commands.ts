import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JobManager } from "./job-manager.ts";
import { formatElapsed } from "./widget.ts";

export function registerBackgroundCommands(pi: ExtensionAPI, manager: JobManager): void {
  const openInteractiveMenu = async (ctx: ExtensionContext) => {
    const jobs = manager.getAllJobs();

    if (jobs.length === 0) {
      ctx.ui.notify("No active or recent background operations.", "info");
      return;
    }

    const jobOptions = jobs.map((j) => {
      const icon = j.status === "running" ? "●" : j.status === "completed" ? "✓" : "✖";
      const duration = formatElapsed(j.startedAt, j.endedAt);
      const target = j.placement === "tab" ? `tab: ${j.tabLabel}` : `pane: ${j.paneId}`;
      return `${icon} [${j.id}] ${j.name} (${j.status}, ${duration}) · ${target}`;
    });

    const chosenOption = await ctx.ui.select(
      "Select background operation:",
      jobOptions,
    );

    if (!chosenOption) return;

    // Find the selected job
    const match = chosenOption.match(/\[(bg-\d+)\]/);
    if (!match) return;
    const jobId = match[1];
    const job = manager.getJob(jobId);
    if (!job) return;

    // Show actions for this job
    const actionOptions = [
      "🚀 Open terminal in dedicated tab (Focus)",
      "📄 View recent terminal output (Scrollback)",
      "🛑 Send interrupt signal (Ctrl+C)",
      "❌ Close terminal and tab permanently",
    ];

    const action = await ctx.ui.select(
      `Job [${job.id}] "${job.name}" - Choose action:`,
      actionOptions,
    );

    if (!action) return;

    if (action.startsWith("🚀")) {
      try {
        await manager.focusJobTab(job.id);
        ctx.ui.notify(`Terminal opened and focused in Herdr: "${job.name}"`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to focus tab: ${err.message}`, "error");
      }
    } else if (action.startsWith("📄")) {
      try {
        const output = await manager.readOutput(job.id, 100);
        await ctx.ui.editor(
          `Terminal log [${job.id}] - ${job.name} (Press Esc to close)`,
          output || "(No output recorded yet)",
        );
      } catch (err: any) {
        ctx.ui.notify(`Failed to read output: ${err.message}`, "error");
      }
    } else if (action.startsWith("🛑")) {
      try {
        await manager.stopJob(job.id);
        ctx.ui.notify(`Sent interrupt signal (Ctrl+C) to [${job.id}]`, "warning");
      } catch (err: any) {
        ctx.ui.notify(`Failed to interrupt job: ${err.message}`, "error");
      }
    } else if (action.startsWith("❌")) {
      const confirm = await ctx.ui.confirm(
        "Confirm Terminal Close",
        `Are you sure you want to permanently close the terminal for [${job.id}]?`,
      );
      if (confirm) {
        try {
          await manager.closeJobTerminal(job.id);
          ctx.ui.notify(`Terminal [${job.id}] closed successfully.`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed to close terminal: ${err.message}`, "error");
        }
      }
    }
  };

  // ── /backgrounds command ──
  pi.registerCommand("backgrounds", {
    description: "View and manage background operations and open terminals",
    handler: async (_args, ctx) => {
      await openInteractiveMenu(ctx);
    },
  });

  // ── /bg alias ──
  pi.registerCommand("bg", {
    description: "Quick alias for /backgrounds",
    handler: async (_args, ctx) => {
      await openInteractiveMenu(ctx);
    },
  });

  // ── Ctrl+Alt+B shortcut ──
  try {
    pi.registerShortcut("ctrl+alt+b", {
      description: "Manage background operations and terminals (ww-backgrounds)",
      handler: async (ctx) => {
        await openInteractiveMenu(ctx);
      },
    });
  } catch {
    // If shortcut is already registered or unsupported in current environment, ignore
  }
}
