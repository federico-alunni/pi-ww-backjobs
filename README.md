# pi-ww-backjobs

[Pi coding agent](https://github.com/badlogic/pi-mono) extension that does one thing: **manage background processes**, for the agent and for the user.

- The agent starts long-running commands (dev servers, watchers, long builds/tests) without blocking its turn.
- The user always sees what is running in a widget above the editor and a footer counter.
- When a job ends, the agent is notified (and woken up if idle), so nobody has to poll.

See [DESIGN.md](DESIGN.md) for the architecture and the contracts.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `background_run` | Start a command; returns immediately. Params: `command`, `name?`, `cwd?`, `onExit?` |
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

## User

- Widget above the editor: running jobs and jobs finished in the last 30 s.
- Footer: number of active jobs.
- `/bg` or `Ctrl+Alt+B`: pick a job, then view output, stop, or remove it.

Jobs belong to the pi session: they are stopped when the session ends or reloads.

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
```

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
