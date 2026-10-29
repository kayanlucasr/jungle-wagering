import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxRepository, OutboxRepository } from '../messaging/ports';
import type { PendingReferenceRepository, ReferenceSchedule } from '../pending-reference/ports';

export interface WalletRepository {
  find(id: string, lock?: boolean): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<boolean>;
  save(wallet: Wallet): Promise<void>;
}

export interface TransactionRepository {
  findIdentities(providerId: string, externalId: string, key: string): Promise<readonly WagerTransaction[]>;
  findExternal(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  find(id: string, lock?: boolean): Promise<WagerTransaction | undefined>;
  findReversals(referenceId: string): Promise<readonly WagerTransaction[]>;
  findByWallet(walletId: string): Promise<readonly WagerTransaction[]>;
  insertPending(transaction: WagerTransaction): Promise<boolean>;
  insertOpening(transaction: WagerTransaction): Promise<void>;
  save(transaction: WagerTransaction, attemptedAt: Date, schedule?: ReferenceSchedule): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  findByWallet(walletId: string): Promise<readonly WalletLedgerEntry[]>;
  findPage(walletId: string, afterVersion: bigint, upperVersion: bigint, limit: number): Promise<readonly WalletLedgerEntry[]>;
}

/** One session belongs to exactly one SQL transaction; never retain it across calls. */
export interface FinancialSession {
  readonly wallets: WalletRepository;
  readonly transactions: TransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
  readonly pendingReferences: PendingReferenceRepository;
}

export interface FinancialUnitOfWork {
  write<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
  readSnapshot<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
}
