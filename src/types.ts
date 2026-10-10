export type JobStatus = "running" | "completed" | "failed" | "stopped";

export interface BackgroundJob {
  id: string;
  name: string;
  command: string;
  cwd: string;
  paneId: string;
  tabId: string;
  tabLabel: string;
  placement: "tab" | "split";
  status: JobStatus;
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
  statusFile: string;
  scriptFile: string;
}

export interface BackgroundRunOptions {
  command: string;
  name?: string;
  cwd?: string;
  placement?: "tab" | "split";
}

export interface HerdrProcessInfo {
  pane_id: string;
  shell_pid?: number;
  foreground_process_group_id?: number;
  foreground_processes?: Array<{
    pid: number;
    name: string;
    argv0?: string;
    cwd?: string;
  }>;
}

export interface HerdrTabRecord {
  tab_id: string;
  label?: string;
  number?: number;
  focused?: boolean;
}

export interface HerdrPaneRecord {
  pane_id: string;
  tab_id?: string;
  terminal_id?: string;
  workspace_id?: string;
  focused?: boolean;
  cwd?: string;
}
