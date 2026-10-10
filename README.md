# ww-backgrounds

Extension for **[Pi coding agent](https://github.com/badlogic/pi-mono)** and **[Herdr](https://herdr.dev)** to view and manage background operations and terminals launched by agents, featuring a status widget above the editor and the ability to promote and manage terminals in dedicated tabs.

---

## Key Features

1. **Non-blocking Agent Execution (`background_run`)**:
   - Agents can launch long-running or persistent tasks (e.g., dev servers `npm run dev`, test watchers `cargo test --watch`, docker compose, build tasks).
   - The agent does not get blocked waiting for the command: the turn completes immediately while the job runs in a real terminal managed by Herdr.

2. **Terminal UI Widget (`setWidget`)**:
   - A bordered status box displayed above the editor showing:
     - Operation status (`● running`, `✓ completed`, `✖ failed`, `■ stopped`).
     - Task name and unique identifier (`[bg-1]`).
     - Herdr target location (e.g., `tab: dev-server` or `pane: w6:p3`).
     - Real-time elapsed time or total duration.
   - All border lines are aligned to the exact terminal width.
   - Automatically hides when there are no active or recent operations.

3. **Open and Manage Terminals (`/bg` or `Ctrl+Alt+B`)**:
   - Interactive selection menu:
     - 🚀 **Open terminal in dedicated tab (Focus)**: brings immediate user focus to the Herdr terminal tab.
     - 📄 **View recent terminal output**: inspect scrollback logs without switching tabs.
     - 🛑 **Send interrupt signal (Ctrl+C)**: terminates the running process.
     - ❌ **Close terminal and tab permanently**: closes the Herdr pane/tab.

---

## Agent Tools

| Tool | Description |
| --- | --- |
| `background_run` | Runs a shell command in a background Herdr terminal (`tab` or `split`). |
| `background_list` | Lists all active and recent background operations with status, duration, and terminal IDs. |
| `background_read` | Reads recent lines of output from the terminal without interrupting it. |
| `background_stop` | Sends an interrupt signal (`Ctrl+C`) to the specified job. |

### Parameters for `background_run`
- `command` (string, required): the shell command to execute.
- `name` (string, optional): short label or descriptive name for the task.
- `cwd` (string, optional): working directory (defaults to current directory).
- `placement` (optional, `"tab"` \| `"split"`, default `"tab"`): where to run the process.

---

## User Commands & Shortcuts

- `/backgrounds` (or `/bg`): opens the interactive management menu.
- `Ctrl+Alt+B`: keyboard shortcut to open the management menu.

---

## Installation

In Pi:

```bash
pi install /Users/federico.alunni/code/personal/ww-backgrounds
```

Or by adding it to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/Users/federico.alunni/code/personal/ww-backgrounds"
  ]
}
```

---

## License

MIT
