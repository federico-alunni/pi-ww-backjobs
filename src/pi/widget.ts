import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isTerminal } from "../core/process-manager.ts";
import type { JobInfo } from "../core/types.ts";
import { STATUS_STYLE, describeStatus, jobDuration } from "./format.ts";

export const WIDGET_KEY = "ww-backgrounds";
/** Finished jobs stay visible for this long. */
export const LINGER_MS = 30_000;
const MAX_ROWS = 6;

type ThemeLike = Pick<Theme, "fg" | "bold">;

export function visibleJobs(jobs: JobInfo[], now = Date.now()): JobInfo[] {
  return jobs.filter((j) => !isTerminal(j.status) || (j.endedAt !== undefined && now - j.endedAt < LINGER_MS));
}

function row(left: string, right: string, width: number, theme: ThemeLike): string {
  const inner = Math.max(0, width - 4);
  const r = truncateToWidth(right, Math.min(visibleWidth(right), inner));
  const l = truncateToWidth(left, Math.max(0, inner - visibleWidth(r) - (r ? 1 : 0)));
  const pad = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
  return `${theme.fg("accent", "│ ")}${l}${" ".repeat(pad)}${r}${theme.fg("accent", " │")}`;
}

/** Box above the editor. Returns [] when there is nothing to show. */
export function renderWidgetLines(jobs: JobInfo[], theme: ThemeLike, availableWidth: number, now = Date.now()): string[] {
  const visible = visibleJobs(jobs, now);
  if (visible.length === 0) return [];

  const width = Math.max(30, availableWidth);
  const active = visible.filter((j) => !isTerminal(j.status)).length;

  const title = ` Background jobs · ${active} active `;
  const titleText = truncateToWidth(title, Math.max(0, width - 4));
  const fill = Math.max(0, width - 3 - visibleWidth(titleText));
  const lines = [
    theme.fg("accent", "╭─") + theme.bold(theme.fg("accent", titleText)) + theme.fg("dim", "─".repeat(fill)) + theme.fg("accent", "╮"),
  ];

  for (const job of visible.slice(0, MAX_ROWS)) {
    const style = STATUS_STYLE[job.status];
    const left = `${theme.fg(style.color, style.icon)} ${theme.bold(job.id)} ${job.name}`;
    const status = isTerminal(job.status) ? `${describeStatus(job)} · ` : "";
    const right = theme.fg("dim", `${status}${jobDuration(job, now)}`);
    lines.push(row(left, right, width, theme));
  }
  if (visible.length > MAX_ROWS) {
    lines.push(row(theme.fg("dim", `… ${visible.length - MAX_ROWS} more`), "", width, theme));
  }
  lines.push(row(theme.fg("dim", "/bg or Ctrl+Alt+B to manage"), "", width, theme));
  lines.push(theme.fg("accent", "╰") + theme.fg("dim", "─".repeat(Math.max(0, width - 2))) + theme.fg("accent", "╯"));
  return lines;
}

export function statusText(jobs: JobInfo[]): string | undefined {
  const active = jobs.filter((j) => !isTerminal(j.status)).length;
  return active > 0 ? `⚙ ${active} bg` : undefined;
}

/** Keeps the widget and footer status in sync with the jobs. */
export class WidgetController {
  private ctx?: ExtensionContext;
  private shown = false;
  /** Last footer text sent; null = never sent. */
  private lastStatus: string | undefined | null = null;
  private requestRender?: () => void;
  private tick?: NodeJS.Timeout;
  private readonly getJobs: () => JobInfo[];

  constructor(getJobs: () => JobInfo[]) {
    this.getJobs = getJobs;
  }

  attach(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.shown = false;
    this.lastStatus = null;
    this.refresh();
  }

  detach(): void {
    this.stopTick();
    if (this.ctx?.hasUI) {
      try {
        this.ctx.ui.setWidget(WIDGET_KEY, undefined);
        this.ctx.ui.setStatus(WIDGET_KEY, undefined);
      } catch {}
    }
    this.ctx = undefined;
    this.shown = false;
    this.requestRender = undefined;
  }

  refresh(): void {
    const ctx = this.ctx;
    if (!ctx?.hasUI) return;
    const jobs = this.getJobs();
    const visible = visibleJobs(jobs).length > 0;

    try {
      const status = statusText(jobs);
      if (status !== this.lastStatus) {
        ctx.ui.setStatus(WIDGET_KEY, status);
        this.lastStatus = status;
      }
      if (ctx.mode === "tui") {
        if (visible && !this.shown) {
          ctx.ui.setWidget(
            WIDGET_KEY,
            (tui, theme) => {
              this.requestRender = () => tui.requestRender();
              return {
                invalidate() {},
                render: (width: number) => renderWidgetLines(this.getJobs(), theme, width),
              };
            },
            { placement: "aboveEditor" },
          );
        } else if (!visible && this.shown) {
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          this.requestRender = undefined;
        } else {
          this.requestRender?.();
        }
      }
    } catch {}

    this.shown = visible;
    if (visible) this.startTick();
    else this.stopTick();
  }

  private startTick(): void {
    if (this.tick) return;
    this.tick = setInterval(() => this.refresh(), 1000);
    this.tick.unref?.();
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
  }
}
