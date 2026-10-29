import { describe, expect, test } from 'bun:test';
import { defaultPendingReferencePolicy, pendingNextAttempt } from '../../src/application/pending-reference/policy';
import { fixtureConfig } from '../support/config';

describe('Pending-reference scheduling policy', () => {
  const at = new Date('2026-10-29T12:00:00.000Z');
  test('uses bounded exponential equal jitter with deterministic injected randomness', () => {
    const deadline = new Date(at.getTime() + 86400000);
    expect(pendingNextAttempt(at, 1, deadline, defaultPendingReferencePolicy, () => 0).getTime() - at.getTime()).toBe(500);
    expect(pendingNextAttempt(at, 3, deadline, defaultPendingReferencePolicy, () => 1).getTime() - at.getTime()).toBe(4000);
    expect(pendingNextAttempt(at, 100000, deadline, defaultPendingReferencePolicy, () => 1).getTime() - at.getTime()).toBe(300000);
  });
  test('never schedules beyond the persisted deadline or mutates its input dates', () => {
    const deadline = new Date(at.getTime() + 100);
    expect(pendingNextAttempt(at, 9, deadline, defaultPendingReferencePolicy, () => 1).toISOString()).toBe(deadline.toISOString());
    expect(at.toISOString()).toBe('2026-10-29T12:00:00.000Z');
    expect(deadline.toISOString()).toBe('2026-10-29T12:00:00.100Z');
  });
  test('configuration preserves approved defaults and freezes policy', () => {
    const policy = fixtureConfig().pendingReference;
    expect(policy).toEqual(defaultPendingReferencePolicy);
    expect(Object.isFrozen(policy)).toBe(true);
  });
  test('rejects unbounded or contradictory operating parameters', () => {
    for (const overrides of [{ PENDING_REFERENCE_TTL_SECONDS: '0' }, { PENDING_REFERENCE_MAX_ATTEMPTS: '1' },
      { PENDING_REFERENCE_POLL_MS: '0' }, { PENDING_REFERENCE_BATCH_SIZE: '0' }, { PENDING_REFERENCE_IDLE_TIMEOUT_MS: '0' },
      { PENDING_REFERENCE_BASE_SECONDS: '10', PENDING_REFERENCE_CAP_SECONDS: '1' }]) {
      expect(() => fixtureConfig(overrides)).toThrow();
    }
  });
});
