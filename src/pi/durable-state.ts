import { existsSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isProcessAlive } from "../backends/local.ts";
import { STATUS_TRANSITIONS, TERMINAL_STATUSES } from "../core/types.ts";

/** Environment variable overriding the root of the durable state. */
export const STATE_DIR_ENV = "PI_WW_BACKJOBS_STATE_DIR";
export const DEFAULT_CLEAN_DAYS = 7;

const RECORD_FILE = /^(bg-\d+)\.json$/;

/** `$PI_WW_BACKJOBS_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/pi-ww-backjobs`. Always absolute. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STATE_DIR_ENV]?.trim();
  if (override) return resolve(override);
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return resolve(base, "pi-ww-backjobs");
}

/** Durable jobs of one pi session: `<root>/<sessionId>/`. */
export function sessionStateDir(root: string, sessionId: string): string {
  // No separators and no leading dots: always a child of root.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";
  return join(root, safe);
}

export interface CleanupResult {
  removedJobs: number;
  removedSessions: number;
}

function unlinkQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {}
}

function mtime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** A record written by the process manager, or undefined for anything else. */
function readRecord(file: string, id: string): { status: string; pid?: number; startedAt: number; endedAt?: number } | undefined {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved?.version !== 1 || saved.id !== id) return undefined;
    if (!Object.hasOwn(STATUS_TRANSITIONS, saved.status) || typeof saved.startedAt !== "number") return undefined;
    return saved;
  } catch {
    return undefined;
  }
}

/**
 * Remove old durable jobs of OTHER sessions (the current one is cleaned by its
 * manager): finished jobs ended before the cutoff (a job whose exit file exists
 * counts as finished at the file's time), and orphans started before the cutoff
 * whose process is gone. Jobs whose process is alive are kept. Only files that
 * are durable records (`bg-N.json`, version 1, matching id, known status) and
 * their `bg-N.log` / `bg-N.exit` are deleted, plus stale `*.tmp` files; empty
 * session directories are removed.
 */
export function cleanupOtherSessions(
  root: string,
  options: { excludeDir?: string; olderThanMs: number; now?: number },
): CleanupResult {
  const result: CleanupResult = { removedJobs: 0, removedSessions: 0 };
  if (!existsSync(root)) return result;
  const cutoff = (options.now ?? Date.now()) - options.olderThanMs;
  const exclude = options.excludeDir ? resolve(options.excludeDir) : undefined;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (dir === exclude) continue;

    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    let records = 0;
    for (const name of names) {
      const id = RECORD_FILE.exec(name)?.[1];
      if (!id) continue;
      const saved = readRecord(join(dir, name), id);
      if (!saved) continue;
      records++;

      const exitAt = mtime(join(dir, `${id}.exit`));
      const terminal = (TERMINAL_STATUSES as readonly string[]).includes(saved.status) || exitAt !== undefined;
      const endedAt = saved.endedAt ?? exitAt ?? 0;
      const old = terminal ? endedAt < cutoff : saved.startedAt < cutoff;
      const orphan = !terminal && !(saved.pid && isProcessAlive(saved.pid));
      if (!old || (!terminal && !orphan)) continue;

      unlinkQuiet(join(dir, `${id}.log`));
      unlinkQuiet(join(dir, `${id}.exit`));
      unlinkQuiet(join(dir, name));
      records--;
      result.removedJobs++;
    }

    // Leftovers of interrupted atomic writes (`bg-N.json.<pid>.tmp`, `bg-N.exit.tmp`).
    for (const name of names) {
      if (!/^bg-\d+\.(json\.\d+|exit)\.tmp$/.test(name)) continue;
      const at = mtime(join(dir, name));
      if (at !== undefined && at < cutoff) unlinkQuiet(join(dir, name));
    }

    if (records > 0) continue;
    try {
      rmdirSync(dir); // only succeeds when empty
      result.removedSessions++;
    } catch {}
  }
  return result;
}
