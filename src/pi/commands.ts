import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTerminal } from "../core/process-manager.ts";
import { DEFAULT_CLEAN_DAYS, cleanupOtherSessions, stateRoot } from "./durable-state.ts";
import { STATUS_STYLE, describeStatus, jobDuration } from "./format.ts";
import type { AdapterState } from "./tools.ts";

const ACTION_VIEW = "View output";
const ACTION_STOP = "Stop";
const ACTION_REMOVE = "Remove from list";
const REMOVE_FINISHED = "Remove all finished jobs";
const VIEW_LINES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export function registerCommands(pi: ExtensionAPI, state: AdapterState): void {
  function notify(ctx: ExtensionContext, text: string, level: "info" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  }

  async function removeFinished(): Promise<number> {
    const removed = await state.manager().removeFinished();
    for (const id of removed) state.cursors.delete(id);
    state.refreshWidget();
    return removed.length;
  }

  /**
   * `/bg clean [days]`: remove the finished jobs of this session, and the
   * durable jobs of other sessions that ended (or were orphaned) more than
   * `days` ago. Running jobs are never touched.
   */
  async function clean(ctx: ExtensionContext, arg: string): Promise<void> {
    const days = arg ? Number(arg) : DEFAULT_CLEAN_DAYS;
    if (!Number.isFinite(days) || days < 0) {
      notify(ctx, `Usage: /bg clean [days] (default ${DEFAULT_CLEAN_DAYS})`, "error");
      return;
    }
    const here = await removeFinished();
    const others = cleanupOtherSessions(stateRoot(), { excludeDir: state.durableDir(), olderThanMs: days * DAY_MS });
    notify(
      ctx,
      `Removed ${here} finished job(s) of this session and ${others.removedJobs} durable job(s) ` +
        `older than ${days} day(s) from other sessions.`,
    );
  }

  async function openMenu(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    const manager = state.manager();
    const jobs = manager.list();
    if (jobs.length === 0) {
      ctx.ui.notify("No background jobs.", "info");
      return;
    }

    const labels = jobs.map((j) => {
      const durable = j.lifetime === "durable" ? " · durable" : "";
      return `${STATUS_STYLE[j.status].icon} ${j.id}  ${j.name}  · ${describeStatus(j)}, ${jobDuration(j)}${durable}`;
    });
    const finished = jobs.filter((j) => isTerminal(j.status)).length;
    const options = finished > 1 ? [...labels, REMOVE_FINISHED] : labels;
    const choice = await ctx.ui.select("Background jobs", options);
    if (!choice) return;
    if (choice === REMOVE_FINISHED) {
      try {
        ctx.ui.notify(`Removed ${await removeFinished()} finished job(s).`, "info");
      } catch (err: any) {
        ctx.ui.notify(`pi-ww-backjobs: ${err?.message ?? err}`, "error");
      }
      return;
    }
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
        state.refreshWidget();
      }
    } catch (err: any) {
      ctx.ui.notify(`pi-ww-backjobs: ${err?.message ?? err}`, "error");
    }
  }

  async function handle(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    const [sub, arg = ""] = (args ?? "").trim().split(/\s+/);
    if (sub === "clean") {
      try {
        await clean(ctx, arg);
      } catch (err: any) {
        notify(ctx, `pi-ww-backjobs: ${err?.message ?? err}`, "error");
      }
      return;
    }
    if (sub) {
      notify(ctx, `Unknown /bg subcommand "${sub}". Usage: /bg, /bg clean [days]`, "error");
      return;
    }
    await openMenu(ctx);
  }

  pi.registerCommand("bg", {
    description: `Manage background jobs: view output, stop, remove. "/bg clean [days]" removes finished jobs and old durable ones (default ${DEFAULT_CLEAN_DAYS} days)`,
    handler: async (args, ctx) => handle(args, ctx),
  });

  pi.registerShortcut("ctrl+alt+b", {
    description: "Manage background jobs",
    handler: async (ctx) => openMenu(ctx),
  });
}
