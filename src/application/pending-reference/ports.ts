import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { EventContext } from '../messaging/integration-event';

export interface ReferenceSchedule { readonly deadline: Date; readonly nextAttemptAt: Date }
export interface PendingReferenceClaim {
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  readonly attempts: number;
  readonly deadline: Date;
  readonly lastAttemptAt: Date | null;
  readonly context: EventContext;
}
export interface PendingReferenceRepository {
  /** Called only inside the financial transaction: wallet SKIP LOCKED, then transaction lock. */
  claim(at: Date, idleTimeoutMs: number): Promise<PendingReferenceClaim | undefined>;
  activeCount(): Promise<number>;
}
export interface PendingResolution {
  readonly transactionId: string;
  readonly walletId: string;
  readonly referenceExternalTransactionId: string;
  readonly correlationId: string;
  readonly attempt: number;
  readonly nextAttemptAt: string | null;
  readonly deadline: string;
  readonly result: string;
  readonly failureCode?: string;
  readonly resolutionAgeMs: number;
}
