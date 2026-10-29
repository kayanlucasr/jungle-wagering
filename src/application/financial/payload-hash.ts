import { createHash } from 'node:crypto';
import type { ExternalTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import type { MoneyProps } from '../../domain/money/money';

export interface SubmitTransaction {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: ExternalTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

/** Called with Money's canonical serialization, never with a client-provided hash. */
export function payloadHash(command: SubmitTransaction): string {
  return createHash('sha256').update(JSON.stringify([
    1, command.providerId, command.externalTransactionId, command.walletId, command.playerId,
    command.money.currency, command.roundId, command.gameId, command.kind, command.money.amount,
    command.referenceExternalTransactionId ?? null,
  ]), 'utf8').digest('hex');
}
