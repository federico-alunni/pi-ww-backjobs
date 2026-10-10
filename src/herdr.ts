import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrPaneRecord, HerdrProcessInfo, HerdrTabRecord } from "./types.ts";

const execFileAsync = promisify(execFile);

export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1";
}

export function getCurrentWorkspaceId(): string | undefined {
  return process.env.HERDR_WORKSPACE_ID;
}

export function getCurrentPaneId(): string | undefined {
  return process.env.HERDR_PANE_ID;
}

export function getCurrentTabId(): string | undefined {
  return process.env.HERDR_TAB_ID;
}

export async function execHerdr(args: string[]): Promise<any> {
  try {
    const { stdout, stderr } = await execFileAsync("herdr", args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = (stdout || stderr || "").trim();
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return output;
    }
  } catch (err: any) {
    const out = (err.stdout || err.stderr || "").trim();
    if (out) {
      try {
        const parsed = JSON.parse(out);
        throw new Error(parsed?.error?.message ?? parsed?.error ?? out);
      } catch (parseErr: any) {
        if (parseErr.message && !parseErr.message.includes("Unexpected token")) {
          throw parseErr;
        }
      }
    }
    throw new Error(err.message || String(err));
  }
}

/**
 * Create a new background tab in Herdr.
 */
export async function createBackgroundTab(options: {
  label: string;
  cwd?: string;
  workspaceId?: string;
  noFocus?: boolean;
}): Promise<{ tabId: string; rootPaneId: string; tabLabel: string; tabNumber?: number }> {
  const workspace = options.workspaceId ?? getCurrentWorkspaceId();
  const args = ["tab", "create"];
  if (workspace) {
    args.push("--workspace", workspace);
  }
  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.label) {
    args.push("--label", options.label);
  }
  if (options.noFocus !== false) {
    args.push("--no-focus");
  }

  const res = await execHerdr(args);
  const tab = res?.result?.tab as HerdrTabRecord | undefined;
  const rootPane = res?.result?.root_pane as HerdrPaneRecord | undefined;

  if (!tab?.tab_id || !rootPane?.pane_id) {
    throw new Error(
      `Failed to create Herdr tab: missing tab_id or root_pane in response (${JSON.stringify(res)})`,
    );
  }

  return {
    tabId: tab.tab_id,
    rootPaneId: rootPane.pane_id,
    tabLabel: tab.label ?? options.label,
    tabNumber: tab.number,
  };
}

/**
 * Split a pane in Herdr.
 */
export async function createSplitPane(options: {
  targetPaneId?: string;
  direction?: "right" | "down";
  cwd?: string;
  ratio?: number;
  noFocus?: boolean;
}): Promise<{ paneId: string; tabId: string }> {
  const target = options.targetPaneId ?? getCurrentPaneId();
  const args = ["pane", "split"];
  if (target) {
    args.push(target);
  } else {
    args.push("--current");
  }
  args.push("--direction", options.direction ?? "right");
  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.ratio) {
    args.push("--ratio", String(options.ratio));
  }
  if (options.noFocus !== false) {
    args.push("--no-focus");
  }

  const res = await execHerdr(args);
  const pane = res?.result?.pane as HerdrPaneRecord | undefined;
  if (!pane?.pane_id) {
    throw new Error(
      `Failed to split pane: missing pane_id in response (${JSON.stringify(res)})`,
    );
  }

  return {
    paneId: pane.pane_id,
    tabId: pane.tab_id ?? getCurrentTabId() ?? "",
  };
}

/**
 * Run a shell command in a specified pane.
 */
export async function runInPane(paneId: string, command: string): Promise<void> {
  await execHerdr(["pane", "run", paneId, command]);
}

/**
 * Rename a pane.
 */
export async function renamePane(paneId: string, label: string): Promise<void> {
  await execHerdr(["pane", "rename", paneId, label]).catch(() => {});
}

/**
 * Switch focus to a specific tab.
 */
export async function focusTab(tabId: string): Promise<void> {
  await execHerdr(["tab", "focus", tabId]);
}

/**
 * Move a pane to its own new tab and focus it.
 */
export async function movePaneToNewTab(
  paneId: string,
  label?: string,
  focus: boolean = true,
): Promise<{ tabId: string }> {
  const args = ["pane", "move", paneId, "--new-tab"];
  if (label) {
    args.push("--label", label);
  }
  if (focus) {
    args.push("--focus");
  } else {
    args.push("--no-focus");
  }
  const res = await execHerdr(args);
  const pane = res?.result?.move_result?.pane as HerdrPaneRecord | undefined;
  return {
    tabId: pane?.tab_id ?? "",
  };
}

/**
 * Read text output from a pane.
 */
export async function readPane(paneId: string, lines: number = 50): Promise<string> {
  const res = await execHerdr([
    "pane",
    "read",
    paneId,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(lines),
    "--format",
    "text",
  ]);
  if (typeof res === "string") return res;
  return res?.result?.output ?? res?.result?.text ?? "";
}

/**
 * Send keys to a pane (e.g. "ctrl+c").
 */
export async function sendKeys(paneId: string, ...keys: string[]): Promise<void> {
  await execHerdr(["pane", "send-keys", paneId, ...keys]);
}

/**
 * Close a pane.
 */
export async function closePane(paneId: string): Promise<void> {
  await execHerdr(["pane", "close", paneId]);
}

/**
 * Close a tab.
 */
export async function closeTab(tabId: string): Promise<void> {
  await execHerdr(["tab", "close", tabId]);
}

/**
 * Query process info of a pane.
 */
export async function getProcessInfo(paneId: string): Promise<HerdrProcessInfo | null> {
  try {
    const res = await execHerdr(["pane", "process-info", "--pane", paneId]);
    return (res?.result?.process_info as HerdrProcessInfo) ?? null;
  } catch {
    return null;
  }
}

/**
 * Inspect pane details.
 */
export async function getPane(paneId: string): Promise<HerdrPaneRecord | null> {
  try {
    const res = await execHerdr(["pane", "get", paneId]);
    return (res?.result?.pane as HerdrPaneRecord) ?? null;
  } catch {
    return null;
  }
}
