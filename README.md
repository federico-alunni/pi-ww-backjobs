# pi-ww-backjobs

[Pi coding agent](https://github.com/badlogic/pi-mono) extension that does one thing: **manage background processes**, for the agent and for the user.

- The agent starts long-running commands (dev servers, watchers, long builds/tests) without blocking its turn.
- The user always sees what is running in a widget above the editor and a footer counter.
- When a job ends, the agent is notified (and woken up if idle), so nobody has to poll.

See [DESIGN.md](DESIGN.md) for the architecture and the contracts.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `background_run` | Start a command; returns immediately. Params: `command`, `name?`, `cwd?`, `onExit?`, `lifetime?` |
| `background_list` | Jobs with status, duration, pid, command |
| `background_read` | Output produced since the agent's last read, or the last `tail` lines |
| `background_wait` | Wait for exit, for a regex in the output (`pattern`), or for `timeoutSeconds` |
| `background_stop` | SIGTERM to the whole process group, SIGKILL after a grace period |

### `onExit`

| Value | When the job ends |
| --- | --- |
| `wake` (default) | Message to the agent; starts a new turn if it is idle |
| `inform` | Message stored in the conversation, no new turn (good for services) |
| `none` | No message; widget and events only |

No duplicate message is sent when the agent already learned the outcome through `background_wait` or `background_stop`. A job stopped by the user from `/bg` is reported with `inform`.

### `lifetime`

| Value | Behaviour |
| --- | --- |
| `session` (default) | The job belongs to the pi session: it is stopped when the session ends or reloads. |
| `durable` | The job keeps running after `/reload`, a crash or pi exiting. When the **same session** starts again (`/reload`, `pi --resume`), it is reattached. |

On reattach a durable job is in one of three states:

- **running**: followed again (`background_read`, `background_wait`, `background_stop`, widget, exit notification);
- **succeeded / failed**: it ended while nobody was watching; the real exit code is read from its exit file and reported **once**, according to its `onExit`;
- **lost**: the process is gone and left no exit status (e.g. killed with `SIGKILL`), or its pid now belongs to another process. pi-ww-backjobs only reports this: it **never restarts** a job. Whether the work happened (did the push land?) is for whoever started the job to verify.

Durable state lives in `~/.local/state/pi-ww-backjobs/<session id>/` (`$XDG_STATE_HOME` is honoured; override the root with `PI_WW_BACKJOBS_STATE_DIR`): one JSON record, the log and the exit file per job. The command's environment is never written to disk. Other sessions do not see these jobs.

## User

- Widget above the editor: running jobs and jobs finished in the last 30 s.
- Footer: number of active jobs.
- `/bg` or `Ctrl+Alt+B`: pick a job, then view output, stop, or remove it; or remove all finished jobs at once.
- `/bg clean [days]`: remove the finished jobs of this session, plus durable jobs of other sessions that ended (or were orphaned, process gone) more than `days` ago (default 7). Running jobs are never touched.

Jobs are stopped when the session ends or reloads, unless started with `lifetime: "durable"`. Finished durable jobs stay in `/bg` and `background_list` until removed.

## Other extensions

Talk to pi-ww-backjobs through `pi.events`, no import needed:

```ts
let backjobs: BackjobsApi | undefined;
pi.events.on("pi-ww-backjobs:api", (api) => (backjobs = api as BackjobsApi));
pi.events.emit("pi-ww-backjobs:request-api", undefined);

pi.events.on("pi-ww-backjobs:event", (event) => {
  // { type: "start" | "status" | "output" | "exit", job, ... }
});

const job = await backjobs?.start({ command: "npm run dev", onExit: "inform" });
const push = await backjobs?.start({ command: "git push", lifetime: "durable", metadata: { op: "push-42" } });
```

`metadata` of a durable job is stored in its record (keep it JSON-serializable) and comes back on reattach: use it to recognise your jobs. A durable job ending while nobody watched emits `status` and `exit` when it is reattached; reattached jobs emit no `start`.

## Installation

```bash
pi install git:github.com/federico-alunni/pi-ww-backjobs
# or from a local checkout
pi install /path/to/pi-ww-backjobs
```

or in `~/.pi/agent/settings.json`:

```json
{ "packages": ["git:github.com/federico-alunni/pi-ww-backjobs"] }
```

## Development

```bash
npm test
```

Requirements: macOS or Linux (the local backend uses POSIX process groups).

## License

MIT
