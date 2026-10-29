import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerRepository } from '../../../application/financial/ports';
import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { LedgerRecord } from '../entities/financial-records';
import { ledgerFromRecord, ledgerToRecord } from '../mappers/financial-mappers';

export class PostgresLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}
  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerRecord, ledgerToRecord(entry));
  }
  async findByWallet(walletId: string) {
    return (await this.em.find(LedgerRecord, { walletId }, { refresh: true,
      orderBy: { walletVersion: 'asc' } })).map(ledgerFromRecord);
  }
  async findPage(walletId: string, afterVersion: bigint, upperVersion: bigint, limit: number) {
    return (await this.em.find(LedgerRecord, { walletId,
      walletVersion: { $gt: afterVersion, $lte: upperVersion } },
    { refresh: true, orderBy: { walletVersion: 'asc' }, limit })).map(ledgerFromRecord);
  }
}
