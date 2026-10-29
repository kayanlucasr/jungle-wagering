import { EntitySchema, BigIntType } from '@mikro-orm/core';
import type { TerminalResult } from '../../../domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import type { FailureCode } from '../../../domain/errors/domain-error';
import type { LedgerDirection } from '../../../domain/ledger/wallet-ledger-entry';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: bigint;
  createdAt!: Date;
  updatedAt!: Date;
}

export class TransactionRecord {
  id!: string;
  providerId!: string | null;
  externalTransactionId!: string | null;
  idempotencyKey!: string | null;
  payloadHash!: string | null;
  payloadSchemaVersion!: number | null;
  walletId!: string;
  playerId!: string;
  currency!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: WagerTransactionKind;
  amount!: string;
  status!: WagerTransactionStatus;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: FailureCode | null;
  resultBalance!: string | null;
  resultCurrency!: string | null;
  resultWalletVersion!: bigint | null;
  resultSchemaVersion!: number | null;
  terminalResult!: TerminalResult | null;
  processingAttempts!: number;
  nextAttemptAt!: Date | null;
  lastAttemptAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  completedAt!: Date | null;
}

export class LedgerRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: bigint;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

// String properties deliberately avoid DecimalType's numeric conversion modes.
const identifier = { type: 'string', columnType: 'wagering.identifier' } as const;
const currency = { type: 'string', columnType: 'wagering.currency_code' } as const;
const amount = { type: 'string', columnType: 'wagering.money_amount' } as const;
const timestamp = { type: Date, columnType: 'timestamptz(3)' } as const;
const version = { type: new BigIntType('bigint'), columnType: 'bigint' };

export const WalletSchema = new EntitySchema<WalletRecord>({ class: WalletRecord, schema: 'wagering', tableName: 'wallets',
  properties: { id: { ...identifier, primary: true }, playerId: identifier, currency, balance: amount,
    version, createdAt: timestamp, updatedAt: timestamp } });

export const TransactionSchema = new EntitySchema<TransactionRecord>({ class: TransactionRecord,
  schema: 'wagering', tableName: 'wager_transactions', properties: {
    id: { ...identifier, primary: true }, providerId: { ...identifier, nullable: true },
    externalTransactionId: { ...identifier, nullable: true }, idempotencyKey: { ...identifier, nullable: true },
    payloadHash: { type: 'string', nullable: true }, payloadSchemaVersion: { type: 'integer', nullable: true },
    walletId: identifier, playerId: identifier, currency, roundId: { ...identifier, nullable: true },
    gameId: { ...identifier, nullable: true }, kind: { type: 'string' }, amount,
    status: { type: 'string' }, referenceExternalTransactionId: { ...identifier, nullable: true },
    referenceTransactionId: { ...identifier, nullable: true }, failureCode: { type: 'string', nullable: true },
    resultBalance: { ...amount, nullable: true }, resultCurrency: { ...currency, nullable: true },
    resultWalletVersion: { ...version, nullable: true }, resultSchemaVersion: { type: 'integer', nullable: true },
    terminalResult: { type: 'json', columnType: 'jsonb', nullable: true }, processingAttempts: { type: 'integer' },
    nextAttemptAt: { ...timestamp, nullable: true }, lastAttemptAt: { ...timestamp, nullable: true },
    createdAt: timestamp, updatedAt: timestamp, completedAt: { ...timestamp, nullable: true },
  } });

export const LedgerSchema = new EntitySchema<LedgerRecord>({ class: LedgerRecord,
  schema: 'wagering', tableName: 'wallet_ledger_entries', properties: {
    id: { ...identifier, primary: true }, walletId: identifier, transactionId: identifier,
    walletVersion: version, direction: { type: 'string' }, amount, currency,
    balanceBefore: amount, balanceAfter: amount, createdAt: timestamp,
  } });

export const financialEntities = [WalletSchema, TransactionSchema, LedgerSchema];
