import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import { findFreePort } from '../../src/main/util/find-free-port';

/** Binds a real loopback server on `port` so the probe sees it as occupied. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('findFreePort', () => {
  it('returns a port >= base that is actually bindable', async () => {
    const base = 53110;
    const port = await findFreePort(base, new Set());
    expect(port).toBeGreaterThanOrEqual(base);
    // It must be genuinely free: we can bind it now.
    const srv = await occupy(port);
    srv.close();
  });

  it('skips an excluded port (returns the next one)', async () => {
    const base = 53210;
    const port = await findFreePort(base, new Set([base]));
    expect(port).not.toBe(base);
    expect(port).toBeGreaterThan(base);
  });

  it('skips a port that is actually occupied', async () => {
    const base = 53310;
    const srv = await occupy(base);
    try {
      const port = await findFreePort(base, new Set());
      expect(port).toBeGreaterThan(base);
    } finally {
      srv.close();
    }
  });

  it('excludes multiple assigned ports (parallel-server scenario)', async () => {
    const base = 53410;
    const port = await findFreePort(base, new Set([base, base + 1]));
    expect(port).toBeGreaterThanOrEqual(base + 2);
  });
});
