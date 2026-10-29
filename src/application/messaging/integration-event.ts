import { randomUUID } from 'node:crypto';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';

export interface EventContext { readonly correlationId: string; readonly causationId?: string }
export interface EventEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly transactionId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export abstract class IntegrationEvent<T extends Readonly<Record<string, unknown>>> {
  abstract readonly eventType: string;
  readonly version = 1;
  readonly eventId = randomUUID();
  protected constructor(readonly transaction: WagerTransaction, readonly context: EventContext,
    readonly occurredAt: Date, readonly data: T) {}
  toJSON(): EventEnvelope {
    return { eventId: this.eventId, eventType: this.eventType, version: this.version,
      aggregateId: this.transaction.walletId, transactionId: this.transaction.id,
      correlationId: this.context.correlationId,
      ...(this.context.causationId === undefined ? {} : { causationId: this.context.causationId }),
      occurredAt: this.occurredAt.toISOString(), data: this.data };
  }
}

function transactionData(t: WagerTransaction) {
  return { walletId: t.walletId, transactionId: t.id, providerId: t.providerId ?? null,
    externalTransactionId: t.externalTransactionId ?? null, kind: t.kind, status: t.status,
    money: t.money.toJSON(), referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    result: t.terminalResult ?? null };
}
type TransactionData = ReturnType<typeof transactionData>;

export class WagerTransactionProcessed extends IntegrationEvent<TransactionData> {
  readonly eventType = 'WagerTransactionProcessed';
  static from(t: WagerTransaction, ctx: EventContext, at: Date) {
    return new WagerTransactionProcessed(t, ctx, at, transactionData(t));
  }
}
export class WagerTransactionRejected extends IntegrationEvent<TransactionData> {
  readonly eventType = 'WagerTransactionRejected';
  static from(t: WagerTransaction, ctx: EventContext, at: Date) {
    return new WagerTransactionRejected(t, ctx, at, transactionData(t));
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<TransactionData> {
  readonly eventType = 'WagerTransactionPendingReference';
  static from(t: WagerTransaction, ctx: EventContext, at: Date) {
    return new WagerTransactionPendingReference(t, ctx, at, transactionData(t));
  }
}
function balanceData(t: WagerTransaction, e: WalletLedgerEntry) {
  return { walletId: t.walletId, transactionId: t.id, providerId: t.providerId ?? null,
    externalTransactionId: t.externalTransactionId ?? null, kind: t.kind, direction: e.direction,
    money: e.money.toJSON(), balanceBefore: e.balanceBefore.toJSON(), balanceAfter: e.balanceAfter.toJSON(),
    walletVersion: e.walletVersion.toString() };
}
export class WalletBalanceChanged extends IntegrationEvent<ReturnType<typeof balanceData>> {
  readonly eventType = 'WalletBalanceChanged';
  static from(t: WagerTransaction, e: WalletLedgerEntry, ctx: EventContext, at: Date) {
    return new WalletBalanceChanged(t, ctx, at, balanceData(t, e));
  }
}

export function financialEvents(t: WagerTransaction, entry: WalletLedgerEntry | undefined,
  ctx: EventContext, at: Date): readonly EventEnvelope[] {
  const status = t.status;
  const event = status === 'PROCESSED' ? WagerTransactionProcessed.from(t, ctx, at)
    : status === 'REJECTED' ? WagerTransactionRejected.from(t, ctx, at)
      : status === 'PENDING_REFERENCE' ? WagerTransactionPendingReference.from(t, ctx, at) : undefined;
  return [...(event ? [event.toJSON()] : []),
    ...(entry ? [WalletBalanceChanged.from(t, entry, ctx, at).toJSON()] : [])];
}
