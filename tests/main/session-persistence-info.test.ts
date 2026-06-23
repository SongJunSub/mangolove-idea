import { describe, it, expect } from 'vitest';
import { resolveEffectivePersistence } from '../../src/main/ipc/register-ipc';

describe('resolveEffectivePersistence (b-full loud fallback)', () => {
  it('lite when unset', () => {
    expect(resolveEffectivePersistence({}, '/abduco')).toEqual({
      requested: 'lite',
      effective: 'lite',
      abducoAvailable: true,
    });
  });

  it('full in effect when requested AND abduco available', () => {
    expect(
      resolveEffectivePersistence({ sessionPersistence: 'full' }, '/opt/homebrew/bin/abduco'),
    ).toEqual({
      requested: 'full',
      effective: 'full',
      abducoAvailable: true,
    });
  });

  it('full requested but DOWNGRADED to lite when abduco is missing (the loud-fallback signal)', () => {
    expect(resolveEffectivePersistence({ sessionPersistence: 'full' }, null)).toEqual({
      requested: 'full',
      effective: 'lite',
      abducoAvailable: false,
    });
  });

  it('treats any non-"full" value as lite', () => {
    // A hand-edited garbage value must not be honored as full.
    expect(
      resolveEffectivePersistence({ sessionPersistence: 'garbage' as 'lite' }, '/abduco').requested,
    ).toBe('lite');
  });
});
