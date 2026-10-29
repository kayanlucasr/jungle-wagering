import { DomainError, FailureCode } from '../errors/domain-error';
import { assertIdentifier, assertNotBefore, instant } from '../invariants';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MovementContext {
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly at: Date;
}

export interface WalletMovement {
  readonly wallet: Wallet;
  readonly ledgerEntry: WalletLedgerEntry | undefined;
}

export class Wallet {
  readonly #createdAt: string;
  readonly #updatedAt: string;

  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    readonly balance: Money,
    readonly version: bigint,
    createdAt: string,
    updatedAt: string,
  ) {
    this.#createdAt = createdAt;
    this.#updatedAt = updatedAt;
    Object.freeze(this);
  }

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    return Wallet.rehydrate({ id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1n, createdAt: props.at, updatedAt: props.at });
  }

  static rehydrate(state: WalletState): Wallet {
    assertIdentifier(state.id);
    assertIdentifier(state.playerId);
    if (state.balance.isNegative() || state.currency !== state.balance.currency ||
        typeof state.version !== 'bigint' || state.version < 1n) throw new DomainError(FailureCode.InvalidWallet);
    const created = instant(state.createdAt);
    const updated = instant(state.updatedAt);
    assertNotBefore(updated, created);
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, created, updated);
  }

  get createdAt(): Date { return new Date(this.#createdAt); }
  get updatedAt(): Date { return new Date(this.#updatedAt); }

  debit(money: Money, context: MovementContext): WalletMovement {
    return this.move(money, LedgerDirection.Debit, context);
  }

  credit(money: Money, context: MovementContext): WalletMovement {
    return this.move(money, LedgerDirection.Credit, context);
  }

  private move(money: Money, direction: LedgerDirection, context: MovementContext): WalletMovement {
    if (money.currency !== this.currency) throw new DomainError(FailureCode.CurrencyMismatch);
    if (money.isNegative()) throw new DomainError(FailureCode.InvalidAmount);
    const at = instant(context.at);
    assertNotBefore(at, this.#updatedAt);
    assertIdentifier(context.transactionId);
    assertIdentifier(context.ledgerEntryId);
    if (money.isZero()) return Object.freeze({ wallet: this, ledgerEntry: undefined });
    if (direction === LedgerDirection.Debit && this.balance.isLessThan(money)) {
      throw new DomainError(FailureCode.InsufficientFunds);
    }
    const balance = direction === LedgerDirection.Credit ? this.balance.add(money) : this.balance.subtract(money);
    const version = this.version + 1n;
    const ledgerEntry = WalletLedgerEntry.create({ id: context.ledgerEntryId, transactionId: context.transactionId,
      walletId: this.id, walletVersion: version, direction, money, balanceBefore: this.balance,
      balanceAfter: balance, createdAt: context.at });
    const wallet = Wallet.rehydrate({ id: this.id, playerId: this.playerId, currency: this.currency,
      balance, version, createdAt: this.createdAt, updatedAt: context.at });
    return Object.freeze({ wallet, ledgerEntry });
  }
}
