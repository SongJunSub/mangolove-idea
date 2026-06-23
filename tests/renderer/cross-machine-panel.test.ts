import { describe, it, expect } from 'vitest';
import { groupByMachine } from '../../src/renderer/components/cross-machine/cross-machine-panel';
import type { CrossMachineSessionPointer } from '../../src/shared/types';

const ptr = (over: Partial<CrossMachineSessionPointer>): CrossMachineSessionPointer => ({
  branch: 'feat-x',
  status: 'running',
  hasActiveTurn: true,
  machineId: 'm-aaaa',
  machineLabel: 'work-mac',
  updatedAt: 1,
  ...over,
});

describe('groupByMachine', () => {
  it('groups pointers by machine and collects each machine sessions', () => {
    const groups = groupByMachine([
      ptr({ machineId: 'm-aaaa', branch: 'feat-x' }),
      ptr({ machineId: 'm-aaaa', branch: 'feat-y' }),
      ptr({ machineId: 'm-bbbb', branch: 'feat-z', machineLabel: 'home' }),
    ]);
    const aaaa = groups.find((g) => g.machineId === 'm-aaaa')!;
    expect(aaaa.sessions.map((s) => s.branch)).toEqual(['feat-x', 'feat-y']);
    expect(groups.find((g) => g.machineId === 'm-bbbb')!.label).toBe('home');
  });

  it('marks the self machine and orders it first', () => {
    const groups = groupByMachine(
      [ptr({ machineId: 'm-other', machineLabel: 'other' }), ptr({ machineId: 'm-self' })],
      'm-self',
    );
    expect(groups[0].machineId).toBe('m-self'); // self first
    expect(groups[0].isSelf).toBe(true);
    expect(groups[1].isSelf).toBe(false);
  });

  it('no self id => no group is self', () => {
    const groups = groupByMachine([ptr({ machineId: 'm-aaaa' })]);
    expect(groups.every((g) => !g.isSelf)).toBe(true);
  });

  it('is [] for no pointers', () => {
    expect(groupByMachine([])).toEqual([]);
  });
});
