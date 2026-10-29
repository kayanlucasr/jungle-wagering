import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletRepository } from '../../../application/financial/ports';
import type { Wallet } from '../../../domain/wallet/wallet';
import { WalletRecord } from '../entities/financial-records';
import { walletFromRecord } from '../mappers/financial-mappers';
import { FinancialError } from '../../../application/financial/errors';

export class PostgresWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}
  async find(id: string, lock = false) {
    const row = await this.em.findOne(WalletRecord, { id }, { refresh: true,
      ...(lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {}) });
    return row === null ? undefined : walletFromRecord(row);
  }
  async insert(wallet: Wallet): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>(`insert into wagering.wallets
      (id, player_id, currency, balance, version, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
    [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toString(), wallet.version.toString(), wallet.createdAt, wallet.updatedAt]);
    return rows.length === 1;
  }
  async save(wallet: Wallet): Promise<void> {
    const changed = await this.em.nativeUpdate(WalletRecord, { id: wallet.id }, {
      balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt });
    if (changed !== 1) throw new FinancialError('PERSISTENCE_INTEGRITY');
  }
}
