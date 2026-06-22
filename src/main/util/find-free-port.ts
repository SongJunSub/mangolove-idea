import { createServer } from 'node:net';

/** Max ports to probe upward from base before giving up (avoids an unbounded scan). */
const MAX_PROBES = 200;

/**
 * Resolves the first TCP port >= base that is NOT in `exclude` and that a server can
 * bind on the loopback interface right now. Probes upward from base. Gives each
 * worktree's dev server a DISTINCT port so parallel servers that do NOT auto-increment
 * (Next/CRA/Express read `PORT`; only Vite auto-increments) don't collide on a fixed
 * port. Best-effort: a tiny TOCTOU window exists between the probe and the server's own
 * bind, which is acceptable for local dev (the server's bind is the final arbiter, and
 * per-worktree log detection reads the ACTUAL printed port regardless).
 */
export async function findFreePort(base: number, exclude: ReadonlySet<number>): Promise<number> {
  for (let port = base; port < base + MAX_PROBES; port += 1) {
    if (exclude.has(port)) continue;
    // Sequential probe (await in loop is intentional): returns the LOWEST free port.
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port in [${base}, ${base + MAX_PROBES})`);
}

/** True iff a TCP server can bind `port` on 127.0.0.1 (closed immediately after). */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
