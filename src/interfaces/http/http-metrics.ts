/** Small per-process counters ready for a future exporter. Never used for financial integrity/dedup. */
export class HttpMetrics {
  private requests = 0;
  private requestDurationMs = 0;
  private reconciliationChecks = 0;
  private reconciliationInconsistencies = 0;

  requestCompleted(durationMs: number): void { this.requests += 1; this.requestDurationMs += durationMs; }
  reconciliationCompleted(consistent: boolean): void {
    this.reconciliationChecks += 1;
    if (!consistent) this.reconciliationInconsistencies += 1;
  }
  snapshot() {
    return { requests: this.requests, requestDurationMs: this.requestDurationMs,
      reconciliationChecks: this.reconciliationChecks, reconciliationInconsistencies: this.reconciliationInconsistencies };
  }
}
