import { FinancialService } from '../../application/financial/financial-service';
import { FinancialError } from '../../application/financial/errors';
import type { PendingReferencePolicy } from '../../application/pending-reference/policy';
import { JsonLogger } from '../observability/json-logger';
import { PendingReferenceMetrics } from '../observability/pending-reference-metrics';
import { backoffSeconds, pause } from '../messaging/retry';

export class ReferenceScheduler {
  private readonly stopping = new AbortController();
  constructor(private readonly financial: FinancialService, private readonly policy: PendingReferencePolicy,
    readonly metrics = new PendingReferenceMetrics(), private readonly logger = new JsonLogger()) {}
  stop(): void { this.stopping.abort(); }
  async tick(): Promise<number> {
    let processed = 0;
    for (; processed < this.policy.batchSize && !this.stopping.signal.aborted; processed += 1) {
      const started = performance.now();
      const result = await this.financial.resolveNextPendingReference();
      if (!result) break;
      this.metrics.attempts += 1;
      const durationMs = Math.round(performance.now() - started);
      this.metrics.processingDurationMs += durationMs;
      if (result.result !== 'PENDING_REFERENCE') {
        this.metrics.completedCount += 1; this.metrics.resolutionAgeMs += result.resolutionAgeMs;
        if (result.result === 'PROCESSED') this.metrics.resolved += 1;
        else if (result.result.startsWith('expired_')) this.metrics.expired += 1;
        else this.metrics.rejected += 1;
      }
      // resolveNextPendingReference resolves only after SQL COMMIT, including deferred constraints.
      this.logger.write('info', 'pending_reference_evaluated', {
        operation: 'resolve_reference', correlationId: result.correlationId, transactionId: result.transactionId, walletId: result.walletId,
        referenceExternalTransactionId: result.referenceExternalTransactionId, attempt: result.attempt,
        nextAttemptAt: result.nextAttemptAt, deadline: result.deadline, result: result.result,
        errorCode: result.failureCode ?? '', durationMs,
      });
    }
    this.metrics.active = await this.financial.pendingReferenceCount();
    return processed;
  }
  async run(): Promise<void> {
    let failures = 0;
    while (!this.stopping.signal.aborted) {
      try {
        await this.tick(); failures = 0;
        await pause(this.policy.pollMs, this.stopping.signal);
      } catch (error) {
        if (!(error instanceof FinancialError) || error.code !== 'PERSISTENCE_UNAVAILABLE') throw error;
        this.metrics.transientFailures += 1;
        this.logger.write('warn', 'pending_reference_retry', { attempt: ++failures, errorCode: error.code });
        // Failed SQL transactions do not consume the persisted financial attempt budget.
        await pause(backoffSeconds(failures, this.policy.baseSeconds, this.policy.capSeconds) * 1000, this.stopping.signal);
      }
    }
  }
}
