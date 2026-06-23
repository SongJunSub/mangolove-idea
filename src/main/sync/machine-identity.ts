import { randomUUID } from 'node:crypto';

/** This machine's stable, NON-identifying id + its display label. */
export interface MachineIdentity {
  readonly machineId: string;
  readonly machineLabel: string;
}

/** The slice of SettingsStore machine-identity needs (structural — SettingsStore satisfies it). */
export interface MachineIdentityStore {
  get(): { machineId?: string; machineLabel?: string };
  set(partial: { machineId?: string; machineLabel?: string }): unknown;
}

/**
 * A NON-identifying default label derived from the machine id — `machine-<first 4
 * hex of the uuid>`. Deliberately never the OS hostname (which would leak PII to the
 * shared remote). Computed on read, not persisted, so it tracks the id and a
 * user-set label always overrides it.
 */
export function defaultMachineLabel(machineId: string): string {
  return `machine-${machineId.slice(0, 4)}`;
}

/**
 * Reads — or lazily creates and persists — this machine's stable id and display
 * label. The id is minted ONCE (crypto.randomUUID) on first call and written back so
 * it is identical across runs (it namespaces this machine's `<machineId>.json` on the
 * sync branch). The label is the persisted `machineLabel` or the non-identifying
 * default; the default is NOT persisted so a later user-set label cleanly overrides.
 * `genId` is injected so the first-run path is deterministic in tests.
 */
export function getOrCreateMachineIdentity(
  store: MachineIdentityStore,
  genId: () => string = randomUUID,
): MachineIdentity {
  const current = store.get();
  let machineId = current.machineId;
  if (!machineId) {
    machineId = genId();
    store.set({ machineId });
  }
  return { machineId, machineLabel: current.machineLabel ?? defaultMachineLabel(machineId) };
}
