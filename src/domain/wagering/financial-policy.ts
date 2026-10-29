import { DomainError, FailureCode } from '../errors/domain-error';
import { assertIdentifier, assertNotBefore, instant } from '../invariants';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { Wallet } from '../wallet/wallet';
import { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';

export interface FinancialDecision {
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  readonly ledgerEntry: WalletLedgerEntry | undefined;
}

export interface ProcessingContext {
  readonly wallet: Wallet | undefined;
  readonly transaction: WagerTransaction;
  readonly reference: WagerTransaction | undefined;
  /** Complete relevant history supplied by the caller; never an idempotency cache. */
  readonly reversals: readonly WagerTransaction[];
  readonly ledgerEntryId: string;
  readonly at: Date;
}

export interface WalletOpening {
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction | undefined;
  readonly ledgerEntry: WalletLedgerEntry | undefined;
}

export class FinancialPolicy {
  private constructor() {}

  static openWallet(props: {
    walletId: string; playerId: string; initialBalance: Money; at: Date;
    openingTransactionId?: string; ledgerEntryId?: string;
  }): WalletOpening {
    const wallet = Wallet.open({ id: props.walletId, playerId: props.playerId, initialBalance: props.initialBalance, at: props.at });
    if (wallet.balance.isZero()) return Object.freeze({ wallet, transaction: undefined, ledgerEntry: undefined });
    if (props.openingTransactionId === undefined || props.ledgerEntryId === undefined) {
      throw new DomainError(FailureCode.InvalidIdentifier);
    }
    const transaction = WagerTransaction.opening({ id: props.openingTransactionId, walletId: wallet.id,
      playerId: wallet.playerId, money: wallet.balance, at: props.at });
    const ledgerEntry = WalletLedgerEntry.create({ id: props.ledgerEntryId, walletId: wallet.id,
      transactionId: transaction.id, walletVersion: 1n, direction: LedgerDirection.Credit, money: wallet.balance,
      balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance, createdAt: props.at });
    return Object.freeze({ wallet, transaction, ledgerEntry });
  }

  static process(input: ProcessingContext): FinancialDecision {
    const { transaction, wallet, reference } = input;
    if (transaction.isTerminal()) throw new DomainError(FailureCode.InvalidTransactionState);
    if (wallet === undefined || wallet.id !== transaction.walletId) throw new DomainError(FailureCode.WalletNotFound);
    const at = instant(input.at);
    assertNotBefore(at, transaction.createdAt.toISOString());
    assertNotBefore(at, wallet.updatedAt.toISOString());
    assertIdentifier(input.ledgerEntryId);
    const terminalContext = { balance: wallet.balance, walletVersion: wallet.version, at: input.at };
    const reject = (code: FailureCode): FinancialDecision => Object.freeze({
      wallet, transaction: transaction.reject(code, terminalContext), ledgerEntry: undefined,
    });
    if (wallet.playerId !== transaction.playerId) return reject(FailureCode.WalletPlayerMismatch);
    if (wallet.currency !== transaction.money.currency) return reject(FailureCode.CurrencyMismatch);
    let resolvedReferenceId: string | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      if (reference === undefined) return Object.freeze({
        wallet, transaction: transaction.markPendingReference(), ledgerEntry: undefined,
      });
      const failure = FinancialPolicy.validateReference(transaction, reference, input.reversals);
      if (failure !== undefined) return reject(failure);
      if (!reference.isTerminal()) return Object.freeze({
        wallet, transaction: transaction.markPendingReference(), ledgerEntry: undefined,
      });
      resolvedReferenceId = reference.id;
    }
    if (transaction.kind === Kind.Loss) return Object.freeze({
      wallet, transaction: transaction.markProcessed({ ...terminalContext,
        ...(resolvedReferenceId === undefined ? {} : { referenceTransactionId: resolvedReferenceId }) }),
      ledgerEntry: undefined,
    });
    const debit = transaction.kind === Kind.Bet || (transaction.kind === Kind.Rollback && reference?.kind !== Kind.Bet);
    try {
      const movementContext = { transactionId: transaction.id, ledgerEntryId: input.ledgerEntryId, at: input.at };
      const movement = debit ? wallet.debit(transaction.money, movementContext) : wallet.credit(transaction.money, movementContext);
      const processed = transaction.markProcessed({ balance: movement.wallet.balance,
        walletVersion: movement.wallet.version, at: input.at,
        ...(resolvedReferenceId === undefined ? {} : { referenceTransactionId: resolvedReferenceId }) });
      return Object.freeze({ wallet: movement.wallet, transaction: processed, ledgerEntry: movement.ledgerEntry });
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === FailureCode.InsufficientFunds) {
        return reject(transaction.kind === Kind.Rollback ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
      }
      if (error instanceof DomainError && error.code === FailureCode.AmountOutOfRange) return reject(error.code);
      throw error;
    }
  }

  private static validateReference(transaction: WagerTransaction, reference: WagerTransaction,
    reversals: readonly WagerTransaction[]): FailureCode | undefined {
    if (transaction.id === reference.id || transaction.externalTransactionId === reference.externalTransactionId ||
        reference.providerId !== transaction.providerId ||
        reference.externalTransactionId !== transaction.referenceExternalTransactionId ||
        reference.playerId !== transaction.playerId || reference.walletId !== transaction.walletId ||
        reference.money.currency !== transaction.money.currency || reference.roundId !== transaction.roundId) {
      return FailureCode.ReferenceContextMismatch;
    }
    const eligible = transaction.kind === Kind.Refund ? reference.kind === Kind.Bet :
      transaction.kind === Kind.Rollback ? [Kind.Bet, Kind.Win, Kind.Refund].includes(reference.kind) :
        reference.kind === Kind.Bet;
    if (!eligible) return FailureCode.ReferenceKindNotAllowed;
    if (transaction.requiresReference() && !transaction.money.equals(reference.money)) return FailureCode.ReferenceAmountMismatch;
    if (!reference.isTerminal()) return undefined;
    if (reference.status !== Status.Processed) return FailureCode.ReferenceNotProcessed;
    if (transaction.requiresReference() && reversals.some((prior) =>
      prior.status === Status.Processed && prior.referenceTransactionId === reference.id &&
      (prior.kind === Kind.Refund || prior.kind === Kind.Rollback))) return FailureCode.ReferenceAlreadyReversed;
    return undefined;
  }
}
