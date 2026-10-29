import { DomainError, FailureCode } from '../../domain/errors/domain-error';
import { assertIdentifier } from '../../domain/invariants';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { FinancialUnitOfWork } from './ports';
import { FinancialError } from './errors';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

export interface LedgerPage { readonly items: readonly WalletLedgerEntry[]; readonly nextCursor: string | null }

/** Reads use the same ports/runtime role as financial commands, without taking financial write locks. */
export class FinancialQueryService {
  constructor(private readonly unitOfWork: FinancialUnitOfWork) {}

  async wallet(walletId: string) {
    assertIdentifier(walletId);
    return this.unitOfWork.readSnapshot(async (session) => {
      const wallet = await session.wallets.find(walletId);
      if (!wallet) throw new DomainError(FailureCode.WalletNotFound);
      return wallet;
    });
  }
  async transaction(id: string) {
    assertIdentifier(id);
    return this.unitOfWork.readSnapshot(async (session) => {
      const transaction = await session.transactions.find(id);
      if (!transaction) throw new FinancialError('TRANSACTION_NOT_FOUND');
      return transaction;
    });
  }
  async externalTransaction(providerId: string, externalId: string) {
    assertIdentifier(providerId); assertIdentifier(externalId);
    return this.unitOfWork.readSnapshot(async (session) => {
      const transaction = await session.transactions.findExternal(providerId, externalId);
      if (!transaction) throw new FinancialError('TRANSACTION_NOT_FOUND');
      return transaction;
    });
  }
  async ledger(walletId: string, limit = 50, cursor?: string): Promise<LedgerPage> {
    assertIdentifier(walletId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new FinancialError('INVALID_CURSOR');
    const position = cursor === undefined ? undefined : decodeLedgerCursor(cursor, walletId);
    return this.unitOfWork.readSnapshot(async (session) => {
      const wallet = await session.wallets.find(walletId);
      if (!wallet) throw new DomainError(FailureCode.WalletNotFound);
      if (position && position.upperVersion > wallet.version) throw new FinancialError('INVALID_CURSOR');
      const upperVersion = position?.upperVersion ?? wallet.version;
      const rows = await session.ledger.findPage(walletId, position?.afterVersion ?? 0n, upperVersion, limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last
        ? encodeLedgerCursor(walletId, last.walletVersion, upperVersion) : null };
    });
  }
}
