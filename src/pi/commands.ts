import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTerminal } from "../core/process-manager.ts";
import { STATUS_STYLE, describeStatus, jobDuration } from "./format.ts";
import type { AdapterState } from "./tools.ts";

const ACTION_VIEW = "View output";
const ACTION_STOP = "Stop";
const ACTION_REMOVE = "Remove from list";
const VIEW_LINES = 200;

export function registerCommands(pi: ExtensionAPI, state: AdapterState): void {
  async function openMenu(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    const manager = state.manager();
    const jobs = manager.list();
    if (jobs.length === 0) {
      ctx.ui.notify("No background jobs.", "info");
      return;
    }

    const labels = jobs.map((j) => `${STATUS_STYLE[j.status].icon} ${j.id}  ${j.name}  · ${describeStatus(j)}, ${jobDuration(j)}`);
    const choice = await ctx.ui.select("Background jobs", labels);
    if (!choice) return;
    const job = jobs[labels.indexOf(choice)];
    if (!job) return;

    const actions = [ACTION_VIEW, isTerminal(job.status) ? ACTION_REMOVE : ACTION_STOP];
    const action = await ctx.ui.select(`[${job.id}] ${job.name}\n$ ${job.command}`, actions);

    try {
      if (action === ACTION_VIEW) {
        const read = await manager.read(job.id, { tail: VIEW_LINES, maxBytes: 64 * 1024 });
        await ctx.ui.editor(`[${job.id}] ${job.name} — last ${VIEW_LINES} lines (log: ${job.logFile})`, read.text || "(no output)");
      } else if (action === ACTION_STOP) {
        state.notifier.markStoppedByUser(job.id);
        ctx.ui.notify(`Stopping [${job.id}]…`, "info");
        const stopped = await manager.stop(job.id);
        ctx.ui.notify(`[${stopped.id}] ${describeStatus(stopped)}`, "info");
      } else if (action === ACTION_REMOVE) {
        await manager.remove(job.id);
        state.cursors.delete(job.id);
      }
    } catch (err: any) {
      ctx.ui.notify(`ww-backgrounds: ${err?.message ?? err}`, "error");
    }
  }

  pi.registerCommand("bg", {
    description: "Manage background jobs: view output, stop, remove",
    handler: async (_args, ctx) => openMenu(ctx),
  });

  pi.registerShortcut("ctrl+alt+b", {
    description: "Manage background jobs",
    handler: async (ctx) => openMenu(ctx),
  });
}
