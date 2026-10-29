import { DomainError, FailureCode } from '../errors/domain-error';
import { assertIdentifier, instant } from '../invariants';
import { Money } from '../money/money';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly walletVersion: bigint;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  readonly #createdAt: string;
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly walletVersion: bigint,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    at: string,
  ) {
    this.#createdAt = at;
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(state);
    if (!entry.money.isPositive() || entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative() ||
        typeof entry.walletVersion !== 'bigint' || entry.walletVersion < 1n || !entry.isBalanced()) {
      throw new DomainError(FailureCode.InvalidLedgerEntry);
    }
    return entry;
  }

  /** Restores immutable data; does not apply a financial transition. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    assertIdentifier(state.id);
    assertIdentifier(state.walletId);
    assertIdentifier(state.transactionId);
    if (!Object.values(LedgerDirection).includes(state.direction)) throw new DomainError(FailureCode.InvalidLedgerEntry);
    return new WalletLedgerEntry(state.id, state.walletId, state.transactionId, state.walletVersion,
      state.direction, state.money, state.balanceBefore, state.balanceAfter, instant(state.createdAt));
  }

  get createdAt(): Date { return new Date(this.#createdAt); }
  get delta(): Money { return this.direction === LedgerDirection.Credit ? this.money : this.money.negate(); }

  isBalanced(): boolean {
    return this.balanceBefore.add(this.delta).equals(this.balanceAfter);
  }
}
