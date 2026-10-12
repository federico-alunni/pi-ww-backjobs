/** Herdr CLI records, used by the (upcoming) Herdr backend. */

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
