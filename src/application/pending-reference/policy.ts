export interface PendingReferencePolicy {
  readonly ttlSeconds: number;
  readonly maxAttempts: number;
  readonly baseSeconds: number;
  readonly capSeconds: number;
  readonly pollMs: number;
  readonly batchSize: number;
  readonly idleTimeoutMs: number;
}
export const defaultPendingReferencePolicy: PendingReferencePolicy = Object.freeze({
  ttlSeconds: 86400, maxAttempts: 20, baseSeconds: 1, capSeconds: 300,
  pollMs: 1000, batchSize: 20, idleTimeoutMs: 10000,
});

/** Attempt 1 is the initial evaluation. Only committed evaluations consume the budget. */
export function pendingNextAttempt(at: Date, attempt: number, deadline: Date,
  policy: PendingReferencePolicy, random: () => number = Math.random): Date {
  const ceiling = Math.min(policy.capSeconds, policy.baseSeconds * 2 ** Math.min(30, Math.max(0, attempt - 1)));
  const delayMs = Math.max(1, Math.ceil(ceiling * 1000 * (0.5 + random() * 0.5)));
  return new Date(Math.min(deadline.getTime(), at.getTime() + delayMs));
}
