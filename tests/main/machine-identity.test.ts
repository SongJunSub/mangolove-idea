import { describe, it, expect } from 'vitest';
import {
  getOrCreateMachineIdentity,
  defaultMachineLabel,
  type MachineIdentityStore,
} from '../../src/main/sync/machine-identity';

/** In-memory store mirroring SettingsStore's get/set shape for machine identity. */
function fakeStore(initial: { machineId?: string; machineLabel?: string } = {}) {
  let state = { ...initial };
  const writes: Array<{ machineId?: string; machineLabel?: string }> = [];
  const store: MachineIdentityStore = {
    get: () => state,
    set: (partial) => {
      writes.push(partial);
      state = { ...state, ...partial };
      return state;
    },
  };
  return { store, writes, current: () => state };
}

describe('defaultMachineLabel', () => {
  it('is the non-identifying machine-<first 4 hex>, never a hostname', () => {
    expect(defaultMachineLabel('55508849-ce45-4bad-96a8-53777e197d82')).toBe('machine-5550');
  });
});

describe('getOrCreateMachineIdentity', () => {
  it('mints + persists a fresh id on first call (deterministic via injected genId)', () => {
    const { store, writes, current } = fakeStore();
    const id = getOrCreateMachineIdentity(store, () => 'abcd1234-0000');
    expect(id.machineId).toBe('abcd1234-0000');
    expect(writes).toEqual([{ machineId: 'abcd1234-0000' }]); // persisted exactly once
    expect(current().machineId).toBe('abcd1234-0000');
    expect(id.machineLabel).toBe('machine-abcd'); // default, NOT persisted
    expect(current().machineLabel).toBeUndefined();
  });

  it('is stable: an existing id is returned and NOT regenerated/rewritten', () => {
    const { store, writes } = fakeStore({ machineId: 'fixed-id-9999' });
    const id = getOrCreateMachineIdentity(store, () => 'SHOULD-NOT-BE-USED');
    expect(id.machineId).toBe('fixed-id-9999');
    expect(writes).toEqual([]); // no write when already present
  });

  it('a user-set label overrides the default; default tracks the id otherwise', () => {
    const labeled = fakeStore({ machineId: 'fixed-id-9999', machineLabel: 'work-mac' });
    expect(getOrCreateMachineIdentity(labeled.store).machineLabel).toBe('work-mac');

    const unlabeled = fakeStore({ machineId: 'fixed-id-9999' });
    expect(getOrCreateMachineIdentity(unlabeled.store).machineLabel).toBe('machine-fixe');
  });
});
