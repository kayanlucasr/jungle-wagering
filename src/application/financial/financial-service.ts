import { randomUUID } from 'node:crypto';
import { DomainError, FailureCode } from '../../domain/errors/domain-error';
import { Money, type MoneyProps } from '../../domain/money/money';
import { FinancialPolicy, type FinancialDecision } from '../../domain/wagering/financial-policy';
import { WagerTransaction, type TerminalResult } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { FinancialSession, FinancialUnitOfWork } from './ports';
import { FinancialError } from './errors';
import { payloadHash, type SubmitTransaction } from './payload-hash';
import { reconcile, type ReconciliationResult } from './reconciliation';
import { financialEvents, type EventContext } from '../messaging/integration-event';
import { MessageConflict } from '../messaging/ports';
import { defaultPendingReferencePolicy, pendingNextAttempt, type PendingReferencePolicy } from '../pending-reference/policy';
import type { PendingResolution, ReferenceSchedule } from '../pending-reference/ports';

export interface SubmissionContext extends EventContext {
  readonly inbox?: { readonly consumerName: string; readonly messageId: string; readonly payloadHash: string };
}

export interface SubmissionResult {
  readonly transactionId: string;
  readonly status: WagerTransaction['status'];
  readonly replay: boolean;
  readonly terminalResult: TerminalResult | undefined;
}

export class FinancialService {
  constructor(private readonly unitOfWork: FinancialUnitOfWork,
    private readonly pendingPolicy: PendingReferencePolicy = defaultPendingReferencePolicy,
    private readonly clock: () => Date = () => new Date(), private readonly random: () => number = Math.random) {}

  async openWallet(input: { id: string; playerId: string; initialBalance: MoneyProps },
    context: EventContext = { correlationId: randomUUID() }): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);
    return this.unitOfWork.write(async (session) => {
      const opening = FinancialPolicy.openWallet({ walletId: input.id, playerId: input.playerId,
        initialBalance, at: this.clock(), openingTransactionId: randomUUID(), ledgerEntryId: randomUUID() });
      if (!await session.wallets.insert(opening.wallet)) throw new FinancialError('WALLET_ALREADY_EXISTS');
      if (opening.transaction) await session.transactions.insertOpening(opening.transaction);
      if (opening.ledgerEntry) await session.ledger.insert(opening.ledgerEntry);
      if (opening.transaction) await session.outbox.enqueue(financialEvents(opening.transaction,
        opening.ledgerEntry, context, opening.wallet.createdAt));
      return opening.wallet;
    });
  }

  async submit(input: SubmitTransaction, context: SubmissionContext = { correlationId: randomUUID() }): Promise<SubmissionResult> {
    // Copy primitives and canonical money before any await; caller mutation cannot change the command.
    const money = Money.from(input.money);
    const command: SubmitTransaction = Object.freeze({ ...input, money: money.toJSON() });
    const hash = payloadHash(command);
    // Factory validates the full external command even when an identity might already exist.
    const proposed = WagerTransaction.create({ ...command, id: randomUUID(), payloadHash: hash,
      money, at: this.clock() });
    return this.unitOfWork.write(async (session) => {
      const inbox = context.inbox;
      if (inbox) {
        const record = await session.inbox.receive(inbox.consumerName, inbox.messageId, inbox.payloadHash, new Date());
        if (record.payloadHash !== inbox.payloadHash) throw new MessageConflict();
        if (record.processedAt !== null) {
          const transaction = record.transactionId ? await session.transactions.find(record.transactionId) : undefined;
          if (!transaction) throw new FinancialError('PERSISTENCE_INTEGRITY');
          return this.result(transaction, true);
        }
      }
      const execute = async (): Promise<SubmissionResult> => {
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
        const at = new Date(Math.max(this.clock().getTime(), wallet.updatedAt.getTime(), transaction.createdAt.getTime()));
        const decision = await this.evaluate(session, wallet, transaction, at);
        const deadline = new Date(at.getTime() + this.pendingPolicy.ttlSeconds * 1000);
        return this.persistDecision(session, decision, at, context, true, decision.transaction.status === 'PENDING_REFERENCE'
          ? { deadline, nextAttemptAt: pendingNextAttempt(at, 1, deadline, this.pendingPolicy, this.random) } : undefined);
      };
      const result = await execute();
      if (inbox) await session.inbox.complete(inbox.consumerName, inbox.messageId, result.transactionId);
      return result;
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

  /** Explicit internal resolution only. Replays through submit never call this path. */
  async resolveNextPendingReference(): Promise<PendingResolution | undefined> {
    return this.unitOfWork.write(async (session) => {
      const claim = await session.pendingReferences.claim(this.clock(), this.pendingPolicy.idleTimeoutMs);
      if (!claim) return undefined;
      const { wallet, transaction, deadline } = claim;
      const at = new Date(Math.max(this.clock().getTime(), wallet.updatedAt.getTime(), transaction.createdAt.getTime(),
        claim.lastAttemptAt?.getTime() ?? 0));
      const attempt = claim.attempts + 1;
      const expired = at.getTime() >= deadline.getTime();
      const exhausted = claim.attempts >= this.pendingPolicy.maxAttempts;
      let result: string;
      let decision: FinancialDecision;
      const rejection = (): FinancialDecision => ({ wallet, ledgerEntry: undefined,
        transaction: transaction.reject(FailureCode.ReferenceNotFound, { balance: wallet.balance, walletVersion: wallet.version, at }) });
      if (expired || exhausted) {
        decision = rejection(); result = expired ? 'expired_ttl' : 'expired_attempts';
      } else {
        decision = await this.evaluate(session, wallet, transaction, at);
        result = decision.transaction.status;
        if (result === 'PENDING_REFERENCE' && attempt >= this.pendingPolicy.maxAttempts) {
          decision = rejection(); result = 'expired_attempts';
        }
      }
      const schedule = decision.transaction.status === 'PENDING_REFERENCE'
        ? { deadline, nextAttemptAt: pendingNextAttempt(at, attempt, deadline, this.pendingPolicy, this.random) } : undefined;
      await this.persistDecision(session, decision, at, claim.context, false, schedule);
      return { transactionId: transaction.id, walletId: wallet.id,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId!, correlationId: claim.context.correlationId,
        attempt, deadline: deadline.toISOString(), nextAttemptAt: schedule?.nextAttemptAt.toISOString() ?? null, result,
        ...(decision.transaction.failureCode ? { failureCode: decision.transaction.failureCode } : {}),
        resolutionAgeMs: at.getTime() - transaction.createdAt.getTime() };
    });
  }

  async pendingReferenceCount(): Promise<number> {
    return this.unitOfWork.readSnapshot((session) => session.pendingReferences.activeCount());
  }

  private async evaluate(session: FinancialSession, wallet: Wallet, transaction: WagerTransaction, at: Date): Promise<FinancialDecision> {
    const reference = transaction.referenceExternalTransactionId === undefined ? undefined
      : await session.transactions.findExternal(transaction.providerId!, transaction.referenceExternalTransactionId);
    const reversals = reference === undefined ? [] : await session.transactions.findReversals(reference.id);
    return FinancialPolicy.process({ wallet, transaction, reference, reversals, at, ledgerEntryId: randomUUID() });
  }

  private async persistDecision(session: FinancialSession, decision: FinancialDecision, at: Date,
    context: EventContext, initial: boolean, schedule?: ReferenceSchedule): Promise<SubmissionResult> {
    if (decision.wallet.version > 9223372036854775807n) throw new FinancialError('WALLET_VERSION_EXHAUSTED');
    if (decision.ledgerEntry) await session.wallets.save(decision.wallet);
    await session.transactions.save(decision.transaction, at, schedule);
    if (decision.ledgerEntry) await session.ledger.insert(decision.ledgerEntry);
    const persisted = await session.transactions.find(decision.transaction.id);
    if (!persisted) throw new FinancialError('PERSISTENCE_INTEGRITY');
    if (initial || persisted.status !== 'PENDING_REFERENCE') {
      await session.outbox.enqueue(financialEvents(persisted, decision.ledgerEntry, context, at));
    }
    return this.result(persisted, false);
  }

  /** Resolve uncertain commit before retrying. Read-only; never compensates or applies money. */
  async confirmedMessage(consumer: string, messageId: string, hash: string): Promise<SubmissionResult | undefined> {
    return this.unitOfWork.readSnapshot(async (session) => {
      const inbox = await session.inbox.find(consumer, messageId);
      if (!inbox) return undefined;
      if (inbox.payloadHash !== hash) throw new MessageConflict();
      if (!inbox.processedAt || !inbox.transactionId) return undefined;
      const transaction = await session.transactions.find(inbox.transactionId);
      if (!transaction) throw new FinancialError('PERSISTENCE_INTEGRITY');
      return this.result(transaction, true);
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
