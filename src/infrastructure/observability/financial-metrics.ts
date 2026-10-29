/** Per-process observations, never used for financial decisions or deduplication. */
export class FinancialMetrics {
  processed = 0;
  rejected = 0;
  pendingReference = 0;
  failed = 0;
  idempotencyConflicts = 0;
  retries = 0;
  lockConflicts = 0;
  transientFailures = 0;
  commits = 0;
  processingDurationMs = 0;

  committed(statuses: readonly string[], durationMs: number): void {
    this.commits += 1;
    this.processingDurationMs += durationMs;
    for (const status of statuses) {
      if (status === 'PROCESSED') this.processed += 1;
      if (status === 'REJECTED') this.rejected += 1;
      if (status === 'PENDING_REFERENCE') this.pendingReference += 1;
      if (status === 'FAILED') this.failed += 1;
    }
  }
  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(Object.entries(this).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  }
}
