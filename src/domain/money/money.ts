import Decimal from 'decimal.js';
import { DomainError, FailureCode } from '../errors/domain-error';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

// Private configuration: changing Decimal's global precision cannot affect Money.
const ExactDecimal = Decimal.clone({ precision: 64, rounding: Decimal.ROUND_HALF_EVEN });
const currencies = new Set(Intl.supportedValuesOf('currency'));
const signedDecimal = /^-?(?:0|[1-9]\d*)\.\d{2}$/;

export class Money {
  readonly #amount: string;

  private constructor(amount: string, readonly currency: string) {
    this.#amount = amount;
    Object.freeze(this);
  }

  /** External contracts: fixed scale and nonnegative amount. */
  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || props.amount.startsWith('-')) {
      throw new DomainError(FailureCode.InvalidAmount);
    }
    return Money.signed(props);
  }

  /** Signed domain values (deltas/reconciliation); never rounds input. */
  static signed(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !signedDecimal.test(props.amount)) {
      throw new DomainError(FailureCode.InvalidAmount);
    }
    if (typeof props.currency !== 'string' || !currencies.has(props.currency)) {
      throw new DomainError(FailureCode.CurrencyMismatch);
    }
    const magnitude = props.amount.replace(/^-/, '');
    if (magnitude.split('.')[0]!.length > 18) throw new DomainError(FailureCode.AmountOutOfRange);
    const canonical = new ExactDecimal(props.amount).toFixed(2);
    return new Money(canonical, props.currency);
  }

  static zero(currency: string): Money { return Money.from({ amount: '0.00', currency }); }
  static rehydrate(props: MoneyProps): Money { return Money.signed(props); }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.signed({ amount: new ExactDecimal(this.#amount).add(other.#amount).toFixed(2), currency: this.currency });
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.signed({ amount: new ExactDecimal(this.#amount).sub(other.#amount).toFixed(2), currency: this.currency });
  }

  negate(): Money {
    return Money.signed({ amount: new ExactDecimal(this.#amount).negated().toFixed(2), currency: this.currency });
  }

  isZero(): boolean { return this.#amount === '0.00'; }
  isPositive(): boolean { return !this.isNegative() && !this.isZero(); }
  isNegative(): boolean { return this.#amount.startsWith('-'); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return new ExactDecimal(this.#amount).lessThan(other.#amount);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#amount === other.#amount;
  }

  toJSON(): MoneyProps { return Object.freeze({ amount: this.#amount, currency: this.currency }); }
  toString(): string { return this.#amount; }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError(FailureCode.CurrencyMismatch);
  }
}
