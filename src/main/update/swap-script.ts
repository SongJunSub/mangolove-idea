/**
 * Generates the detached helper script that swaps the .app bundle AFTER this process exits.
 * A running bundle cannot replace itself, so we hand the swap to a tiny shell script that:
 *   waits for OUR EXACT pid to exit -> moves the old bundle aside -> `ditto`s the staged new
 *   bundle into place -> relaunches -> rolls back on any failure.
 *
 * PURE (returns the script text) so it is fully unit-tested. SAFETY: it waits on ONE exact
 * pid via `kill -0` (an existence check, never a kill, never a broad pattern), aborts if the
 * app refuses to exit (never swaps a live bundle), and shell-quotes every path.
 */

export interface SwapScriptParams {
  /** The exact pid of the running app to wait for (process.pid). */
  readonly pid: number;
  /** The live .app bundle to replace. */
  readonly appPath: string;
  /** The staged, quarantine-stripped new .app bundle. */
  readonly stagedPath: string;
  /** Where to move the old bundle while swapping (rollback source). */
  readonly backupPath: string;
  /** A file the helper appends its log to (for post-mortem of a failed swap). */
  readonly logPath: string;
}

/** Single-quote a string for POSIX sh, escaping embedded single quotes. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Returns the bash source of the swap helper. */
export function buildSwapScript(p: SwapScriptParams): string {
  return `#!/bin/bash
set -u
PID=${Math.trunc(p.pid)}
APP=${shQuote(p.appPath)}
STAGED=${shQuote(p.stagedPath)}
BACKUP=${shQuote(p.backupPath)}
LOG=${shQuote(p.logPath)}
exec >>"$LOG" 2>&1
echo "[mangolove-update] waiting for pid $PID to exit"
# Wait for THIS exact pid only (kill -0 = existence check, never a kill, never a pattern).
ALIVE=1
for _ in $(seq 1 300); do
  if ! kill -0 "$PID" 2>/dev/null; then ALIVE=0; break; fi
  sleep 0.2
done
if [ "$ALIVE" = "1" ]; then
  echo "[mangolove-update] app did not exit within 60s; aborting (bundle untouched)"
  exit 1
fi
echo "[mangolove-update] swapping bundle"
rm -rf "$BACKUP"
if ! mv "$APP" "$BACKUP"; then
  echo "[mangolove-update] could not move the old bundle aside; aborting"
  exit 1
fi
if ditto "$STAGED" "$APP"; then
  rm -rf "$BACKUP" "$STAGED"
  echo "[mangolove-update] swap complete; relaunching"
  open "$APP"
else
  echo "[mangolove-update] ditto failed; rolling back"
  rm -rf "$APP"
  mv "$BACKUP" "$APP"
  open "$APP"
  exit 1
fi
`;
}
