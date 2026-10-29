import { DomainError, FailureCode } from '../errors/domain-error';
import { assertIdentifier, assertNotBefore, instant } from '../invariants';
import { Money, type MoneyProps } from '../money/money';
import { WagerTransactionKind, type ExternalTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

type TerminalStatus = WagerTransactionStatus.Processed | WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed;

/** JSON-safe, immutable financial result; the transport adds idempotentReplay later. */
export interface TerminalResult {
  readonly transactionId: string;
  readonly status: TerminalStatus;
  readonly balance: MoneyProps;
  readonly walletVersion: string;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: FailureCode | undefined;
  readonly completedAt: string;
}

export interface TerminalContext {
  readonly balance: Money;
  readonly walletVersion: bigint;
  readonly at: Date;
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: ExternalTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly at: Date;
}

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly payloadHash: string | undefined;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly referenceTransactionId: string | undefined;
  readonly status: WagerTransactionStatus;
  readonly terminalResult: TerminalResult | undefined;
  readonly createdAt: Date;
}

type StoredState = Omit<WagerTransactionState, 'createdAt'> & { readonly createdAt: string };

export class WagerTransaction {
  readonly #state: Readonly<StoredState>;
  private constructor(state: StoredState) {
    this.#state = Object.freeze(state);
    Object.freeze(this);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if ((props.kind as WagerTransactionKind) === WagerTransactionKind.Opening ||
        !Object.values(WagerTransactionKind).includes(props.kind)) throw new DomainError(FailureCode.InvalidReference);
    if (props.money.isNegative() || (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive())) {
      throw new DomainError(FailureCode.InvalidAmount);
    }
    if ([WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(props.kind) &&
        props.referenceExternalTransactionId === undefined) throw new DomainError(FailureCode.InvalidReference);
    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new DomainError(FailureCode.InvalidReference);
    }
    return WagerTransaction.rehydrate({
      id: props.id, providerId: props.providerId, externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey, payloadHash: props.payloadHash, walletId: props.walletId,
      playerId: props.playerId, roundId: props.roundId, gameId: props.gameId, kind: props.kind,
      money: props.money, referenceExternalTransactionId: props.referenceExternalTransactionId,
      referenceTransactionId: undefined, status: WagerTransactionStatus.Pending,
      terminalResult: undefined, createdAt: props.at,
    });
  }

  /** Only a domain opening bundle calls this; external creation rejects OPENING. */
  static opening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    if (!props.money.isPositive()) throw new DomainError(FailureCode.InvalidAmount);
    const pending = WagerTransaction.rehydrate({
      id: props.id, walletId: props.walletId, playerId: props.playerId, kind: WagerTransactionKind.Opening,
      money: props.money, createdAt: props.at, providerId: undefined, externalTransactionId: undefined,
      idempotencyKey: undefined, payloadHash: undefined, roundId: undefined, gameId: undefined,
      referenceExternalTransactionId: undefined, referenceTransactionId: undefined,
      status: WagerTransactionStatus.Pending, terminalResult: undefined,
    });
    return pending.markProcessed({ balance: props.money, walletVersion: 1n, at: props.at });
  }

  /** Structural reconstruction only; no transition, debit, credit or opening is replayed. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    assertIdentifier(state.id);
    assertIdentifier(state.walletId);
    assertIdentifier(state.playerId);
    if (!Object.values(WagerTransactionKind).includes(state.kind) ||
        !Object.values(WagerTransactionStatus).includes(state.status)) throw new DomainError(FailureCode.InvalidTransactionState);
    if (state.kind !== WagerTransactionKind.Opening) {
      for (const value of [state.providerId, state.externalTransactionId, state.idempotencyKey, state.roundId, state.gameId]) {
        if (value === undefined) throw new DomainError(FailureCode.InvalidIdentifier);
        assertIdentifier(value);
      }
      if (typeof state.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(state.payloadHash)) {
        throw new DomainError(FailureCode.InvalidIdentifier);
      }
    }
    if (state.referenceExternalTransactionId !== undefined) assertIdentifier(state.referenceExternalTransactionId);
    if (state.referenceTransactionId !== undefined) assertIdentifier(state.referenceTransactionId);
    const createdAt = instant(state.createdAt);
    const terminal = isTerminal(state.status);
    if (terminal !== (state.terminalResult !== undefined)) throw new DomainError(FailureCode.InvalidTransactionState);
    let result: TerminalResult | undefined;
    if (state.terminalResult !== undefined) {
      const source = state.terminalResult;
      if (source.transactionId !== state.id || source.status !== state.status ||
          source.referenceTransactionId !== state.referenceTransactionId ||
          !/^[1-9]\d*$/.test(source.walletVersion) ||
          (source.status === WagerTransactionStatus.Processed ? source.failureCode !== undefined :
            !Object.values(FailureCode).includes(source.failureCode!))) {
        throw new DomainError(FailureCode.InvalidTransactionState);
      }
      const completedAt = instant(new Date(source.completedAt));
      assertNotBefore(completedAt, createdAt);
      result = Object.freeze({ ...source, completedAt, balance: Money.from(source.balance).toJSON() });
    }
    return new WagerTransaction({ ...state, createdAt, terminalResult: result });
  }

  get id(): string { return this.#state.id; }
  get providerId(): string | undefined { return this.#state.providerId; }
  get externalTransactionId(): string | undefined { return this.#state.externalTransactionId; }
  get idempotencyKey(): string | undefined { return this.#state.idempotencyKey; }
  get payloadHash(): string | undefined { return this.#state.payloadHash; }
  get walletId(): string { return this.#state.walletId; }
  get playerId(): string { return this.#state.playerId; }
  get roundId(): string | undefined { return this.#state.roundId; }
  get gameId(): string | undefined { return this.#state.gameId; }
  get kind(): WagerTransactionKind { return this.#state.kind; }
  get money(): Money { return this.#state.money; }
  get status(): WagerTransactionStatus { return this.#state.status; }
  get referenceExternalTransactionId(): string | undefined { return this.#state.referenceExternalTransactionId; }
  get referenceTransactionId(): string | undefined { return this.#state.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.#state.terminalResult?.failureCode; }
  get terminalResult(): TerminalResult | undefined { return this.#state.terminalResult; }
  get createdAt(): Date { return new Date(this.#state.createdAt); }
  get processedAt(): Date | undefined {
    return this.status === WagerTransactionStatus.Processed && this.terminalResult !== undefined
      ? new Date(this.terminalResult.completedAt) : undefined;
  }

  isTerminal(): boolean { return isTerminal(this.status); }
  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean { return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback; }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }

  markPendingReference(): WagerTransaction {
    this.assertNonterminal();
    if (this.referenceExternalTransactionId === undefined) throw new DomainError(FailureCode.InvalidReference);
    if (this.status === WagerTransactionStatus.PendingReference) return this;
    return new WagerTransaction({ ...this.#state, status: WagerTransactionStatus.PendingReference });
  }

  markProcessed(context: TerminalContext & { readonly referenceTransactionId?: string }): WagerTransaction {
    this.assertNonterminal();
    if (context.balance.currency !== this.money.currency) throw new DomainError(FailureCode.CurrencyMismatch);
    if ((this.referenceExternalTransactionId !== undefined) !== (context.referenceTransactionId !== undefined)) {
      throw new DomainError(FailureCode.InvalidReference);
    }
    if (context.referenceTransactionId !== undefined) {
      assertIdentifier(context.referenceTransactionId);
      if (context.referenceTransactionId === this.id) throw new DomainError(FailureCode.InvalidReference);
    }
    return this.complete(WagerTransactionStatus.Processed, context, undefined, context.referenceTransactionId);
  }

  reject(code: FailureCode, context: TerminalContext): WagerTransaction {
    return this.complete(WagerTransactionStatus.Rejected, context, code);
  }

  fail(code: FailureCode, context: TerminalContext): WagerTransaction {
    return this.complete(WagerTransactionStatus.Failed, context, code);
  }

  toState(): WagerTransactionState {
    return Object.freeze({ ...this.#state, createdAt: this.createdAt });
  }

  private assertNonterminal(): void {
    if (this.isTerminal()) throw new DomainError(FailureCode.InvalidTransactionState);
  }

  private complete(status: TerminalStatus, context: TerminalContext, failureCode?: FailureCode,
    referenceTransactionId?: string): WagerTransaction {
    this.assertNonterminal();
    if (context.balance.isNegative() || typeof context.walletVersion !== 'bigint' || context.walletVersion < 1n) {
      throw new DomainError(FailureCode.InvalidWallet);
    }
    if (status !== WagerTransactionStatus.Processed && !Object.values(FailureCode).includes(failureCode!)) {
      throw new DomainError(FailureCode.InvalidTransactionState);
    }
    const completedAt = instant(context.at);
    assertNotBefore(completedAt, this.#state.createdAt);
    const terminalResult: TerminalResult = Object.freeze({ transactionId: this.id, status,
      balance: context.balance.toJSON(), walletVersion: context.walletVersion.toString(),
      failureCode, referenceTransactionId, completedAt });
    return new WagerTransaction({ ...this.#state, status, referenceTransactionId, terminalResult });
  }
}

function isTerminal(status: WagerTransactionStatus): boolean {
  return status === WagerTransactionStatus.Processed || status === WagerTransactionStatus.Rejected ||
    status === WagerTransactionStatus.Failed;
}
