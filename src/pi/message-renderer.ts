import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { JobInfo } from "../core/types.ts";
import { STATUS_STYLE, describeStatus, jobDuration } from "./format.ts";
import { EXIT_MESSAGE_TYPE, type OnExit } from "./notifier.ts";

export function registerMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<{ job: JobInfo; onExit: OnExit }>(EXIT_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
    const job = message.details?.job;
    const body = typeof message.content === "string" ? message.content : "";
    let rendered: string;
    if (!job) {
      rendered = body;
    } else {
      const style = STATUS_STYLE[job.status];
      rendered =
        `${theme.fg(style.color, style.icon)} ${theme.bold(`[${job.id}]`)} ${job.name} ` +
        theme.fg("dim", `${describeStatus(job)} · ${jobDuration(job)}`);
      if (expanded) rendered += `\n${theme.fg("dim", body)}`;
    }
    const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(rendered, 0, 0));
    return box;
  });
}
