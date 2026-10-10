import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BackgroundJob } from "./types.ts";

const LINGER_MS = 30_000; // Keep finished jobs visible for 30s

export function formatElapsed(startedAt: number, endedAt?: number): string {
  const diffSec = Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function borderTop(title: string, info: string, width: number, theme: Theme): string {
  const leftPart = `╭─ ${title} `;
  const rightPart = (info ? ` ${info} ` : "") + "─╮";
  const leftVis = visibleWidth(leftPart);
  const rightVis = visibleWidth(rightPart);
  const fillLen = Math.max(0, width - leftVis - rightVis);
  const fill = "─".repeat(fillLen);

  const leftText =
    theme.fg("accent", "╭─ ") +
    theme.bold(theme.fg("accent", title)) +
    theme.fg("accent", " ");
  const midText = theme.fg("dim", fill);
  const rightText = (info ? theme.fg("dim", ` ${info} `) : "") + theme.fg("accent", "─╮");
  return `${leftText}${midText}${rightText}`;
}

function borderLine(left: string, right: string, width: number, theme: Theme): string {
  const contentWidth = Math.max(0, width - 4); // inside "│ " and " │"
  const rightVis = visibleWidth(right);

  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const pad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${theme.fg("accent", "│ ")}${truncRight}${" ".repeat(pad)}${theme.fg("accent", " │")}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);

  return `${theme.fg("accent", "│ ")}${truncLeft}${" ".repeat(pad)}${right}${theme.fg("accent", " │")}`;
}

function borderBottom(width: number, theme: Theme): string {
  const inner = Math.max(0, width - 2);
  return `${theme.fg("accent", "╰")}${theme.fg("dim", "─".repeat(inner))}${theme.fg("accent", "╯")}`;
}

export function renderWidgetLines(
  jobs: BackgroundJob[],
  theme: Theme,
  availableWidth = 80,
): string[] | undefined {
  const now = Date.now();
  // Filter running jobs and recent completed/failed/stopped jobs
  const visible = jobs.filter((j) => {
    if (j.status === "running") return true;
    return j.endedAt && now - j.endedAt < LINGER_MS;
  });

  if (visible.length === 0) {
    return undefined;
  }

  const runningCount = visible.filter((j) => j.status === "running").length;
  const width = Math.max(40, Math.min(availableWidth, 100));

  const activeLabel = runningCount === 1 ? "1 active" : `${runningCount} active`;
  const title = `⚡ Backgrounds (${activeLabel})`;
  const topBorder = borderTop(title, "", width, theme);

  const lines: string[] = [topBorder];

  for (const job of visible) {
    let icon = "●";
    let iconColor: "success" | "error" | "muted" = "success";
    let rightStatus = "";

    switch (job.status) {
      case "running":
        icon = "●";
        iconColor = "success";
        rightStatus = formatElapsed(job.startedAt);
        break;
      case "completed":
        icon = "✓";
        iconColor = "success";
        rightStatus = `completed (${formatElapsed(job.startedAt, job.endedAt)})`;
        break;
      case "failed":
        icon = "✖";
        iconColor = "error";
        rightStatus = `failed (${job.exitCode ?? 1})`;
        break;
      case "stopped":
        icon = "■";
        iconColor = "muted";
        rightStatus = `stopped (${formatElapsed(job.startedAt, job.endedAt)})`;
        break;
    }

    const dot = theme.fg(iconColor, icon);
    const id = theme.bold(`[${job.id}]`);
    const name = job.name.length > 25 ? `${job.name.slice(0, 23)}…` : job.name;
    const target = job.placement === "tab" ? `tab: ${job.tabLabel}` : `pane: ${job.paneId}`;
    const targetStyled = theme.fg("dim", target);

    const left = `${dot} ${id} ${name} · ${targetStyled}`;
    const right = theme.fg("dim", rightStatus);

    lines.push(borderLine(left, right, width, theme));
  }

  // Footer hint
  const hintText = theme.fg("dim", "Ctrl+Alt+B or /bg to manage terminals & tabs");
  lines.push(borderLine(hintText, "", width, theme));

  const bottomBorder = borderBottom(width, theme);
  lines.push(bottomBorder);

  return lines;
}
