import { randomUUID } from 'node:crypto';
import { DomainError, FailureCode } from '../../domain/errors/domain-error';
import { Money, type MoneyProps } from '../../domain/money/money';
import { FinancialPolicy } from '../../domain/wagering/financial-policy';
import { WagerTransaction, type TerminalResult } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { FinancialSession, FinancialUnitOfWork } from './ports';
import { FinancialError } from './errors';
import { payloadHash, type SubmitTransaction } from './payload-hash';
import { reconcile, type ReconciliationResult } from './reconciliation';

export interface SubmissionResult {
  readonly transactionId: string;
  readonly status: WagerTransaction['status'];
  readonly replay: boolean;
  readonly terminalResult: TerminalResult | undefined;
}

export class FinancialService {
  constructor(private readonly unitOfWork: FinancialUnitOfWork) {}

  async openWallet(input: { id: string; playerId: string; initialBalance: MoneyProps }): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);
    return this.unitOfWork.write(async (session) => {
      const opening = FinancialPolicy.openWallet({ walletId: input.id, playerId: input.playerId,
        initialBalance, at: new Date(), openingTransactionId: randomUUID(), ledgerEntryId: randomUUID() });
      if (!await session.wallets.insert(opening.wallet)) throw new FinancialError('WALLET_ALREADY_EXISTS');
      if (opening.transaction) await session.transactions.insertOpening(opening.transaction);
      if (opening.ledgerEntry) await session.ledger.insert(opening.ledgerEntry);
      return opening.wallet;
    });
  }

  async submit(input: SubmitTransaction): Promise<SubmissionResult> {
    // Copy primitives and canonical money before any await; caller mutation cannot change the command.
    const money = Money.from(input.money);
    const command: SubmitTransaction = Object.freeze({ ...input, money: money.toJSON() });
    const hash = payloadHash(command);
    // Factory validates the full external command even when an identity might already exist.
    const proposed = WagerTransaction.create({ ...command, id: randomUUID(), payloadHash: hash,
      money, at: new Date() });
    return this.unitOfWork.write(async (session) => {
      const existing = await this.identify(session, command, hash);
      if (existing) return this.result(existing, true);
      const wallet = await session.wallets.find(command.walletId, true);
      if (!wallet) throw new DomainError(FailureCode.WalletNotFound);
      const current = await this.identify(session, command, hash);
      if (current) return this.result(current, true);
      if (!await session.transactions.insertPending(proposed)) {
        const winner = await this.identify(session, command, hash);
        if (!winner) throw new FinancialError('PERSISTENCE_INTEGRITY');
        return this.result(winner, true);
      }
      const transaction = await session.transactions.find(proposed.id, true);
      if (!transaction) throw new FinancialError('PERSISTENCE_INTEGRITY');
      const reference = command.referenceExternalTransactionId === undefined ? undefined
        : await session.transactions.findExternal(command.providerId, command.referenceExternalTransactionId);
      const reversals = reference === undefined ? [] : await session.transactions.findReversals(reference.id);
      const at = new Date(Math.max(Date.now(), wallet.updatedAt.getTime(), transaction.createdAt.getTime()));
      const decision = FinancialPolicy.process({ wallet, transaction, reference, reversals, at,
        ledgerEntryId: randomUUID() });
      if (decision.wallet.version > 9223372036854775807n) throw new FinancialError('WALLET_VERSION_EXHAUSTED');
      if (decision.ledgerEntry) await session.wallets.save(decision.wallet);
      await session.transactions.save(decision.transaction, at);
      if (decision.ledgerEntry) await session.ledger.insert(decision.ledgerEntry);
      const persisted = await session.transactions.find(decision.transaction.id);
      if (!persisted) throw new FinancialError('PERSISTENCE_INTEGRITY');
      return this.result(persisted, false);
    });
  }

  async reconcile(walletId: string): Promise<ReconciliationResult> {
    return this.unitOfWork.readSnapshot(async (session) => {
      const wallet = await session.wallets.find(walletId);
      if (!wallet) throw new DomainError(FailureCode.WalletNotFound);
      return reconcile(wallet, await session.ledger.findByWallet(walletId),
        await session.transactions.findByWallet(walletId));
    });
  }

  private async identify(session: FinancialSession, command: SubmitTransaction, hash: string) {
    const matches = await session.transactions.findIdentities(command.providerId,
      command.externalTransactionId, command.idempotencyKey);
    if (matches.length === 0) return undefined;
    const transaction = matches[0]!;
    if (matches.length !== 1 || transaction.providerId !== command.providerId
      || transaction.externalTransactionId !== command.externalTransactionId
      || transaction.idempotencyKey !== command.idempotencyKey || !transaction.matchesPayload(hash)) {
      throw new FinancialError('IDEMPOTENCY_CONFLICT');
    }
    // No transition from a replay path, including PENDING/PENDING_REFERENCE.
    return transaction;
  }

  private result(transaction: WagerTransaction, replay: boolean): SubmissionResult {
    return Object.freeze({ transactionId: transaction.id, status: transaction.status,
      terminalResult: transaction.terminalResult, replay });
  }
}
