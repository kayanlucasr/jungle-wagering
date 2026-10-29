import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Money } from '../../../src/domain/money/money';
import { FailureCode } from '../../../src/domain/errors/domain-error';
import { expectCode, money } from '../../support/domain';

describe('Money', () => {
  test('adds decimal cents exactly and serializes as strings', () => {
    const result = money('0.10').add(money('0.20'));
    expect(result.toString()).toBe('0.30');
    expect(JSON.stringify(result)).toBe('{"amount":"0.30","currency":"BRL"}');
  });

  test('handles values above the JavaScript safe integer limit exactly', () => {
    expect(money('9007199254740993.01').add(money('0.01')).toString()).toBe('9007199254740993.02');
    expect(money('999999999999999999.99').subtract(money('999999999999999999.98')).toString()).toBe('0.01');
  });

  test('subtracts, negates and normalizes signed zero', () => {
    const negative = money('1.00').subtract(money('2.00'));
    expect(negative.toString()).toBe('-1.00');
    expect(negative.negate().toString()).toBe('1.00');
    expect(Money.signed({ amount: '-0.00', currency: 'BRL' }).toString()).toBe('0.00');
    expect(Money.zero('BRL').negate().isZero()).toBe(true);
    expect(negative.isNegative()).toBe(true);
    expect(money('0.01').isPositive()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
  });

  test('compares and checks equality exactly', () => {
    expect(money('1.01').isLessThan(money('1.02'))).toBe(true);
    expect(money('1.00').equals(money('1.00'))).toBe(true);
    expect(money('1.00').equals(money('1.01'))).toBe(false);
    expect(Money.signed({ amount: '-1.00', currency: 'BRL' }).isLessThan(Money.zero('BRL'))).toBe(true);
  });

  for (const amount of ['', ' ', 'NaN', 'Infinity', '-Infinity', '1e2', '1E+2', '1.001', '1.005',
    '1', '1.0', '01.00', '+1.00', ' 1.00', '1.00 ', '1,00', '.10', '0x10', '-1.00', '-0.00']) {
    test(`rejects external amount ${JSON.stringify(amount)} without rounding`, () => {
      expectCode(() => money(amount), FailureCode.InvalidAmount);
    });
  }

  test('rejects numeric JSON input at runtime', () => {
    expectCode(() => money(0.1 as unknown as string), FailureCode.InvalidAmount);
  });

  test('rejects input and arithmetic overflow', () => {
    expectCode(() => money('1000000000000000000.00'), FailureCode.AmountOutOfRange);
    expectCode(() => money('999999999999999999.99').add(money('0.01')), FailureCode.AmountOutOfRange);
    expectCode(() => Money.signed({ amount: '-999999999999999999.99', currency: 'BRL' }).subtract(money('0.01')),
      FailureCode.AmountOutOfRange);
  });

  for (const operation of ['add', 'subtract', 'equals', 'isLessThan'] as const) {
    test(`rejects currency mismatch in ${operation}`, () => {
      expectCode(() => money('1.00')[operation](money('1.00', 'USD')), FailureCode.CurrencyMismatch);
    });
  }

  for (const currency of ['brl', ' BRL', 'BR', 'FAKE', 'ZZZ', '']) {
    test(`rejects invalid currency ${JSON.stringify(currency)}`, () => {
      expectCode(() => money('1.00', currency), FailureCode.CurrencyMismatch);
    });
  }

  test('protects originals and serialized data against mutation', () => {
    const props = { amount: '10.00', currency: 'BRL' };
    const original = Money.from(props);
    props.amount = '99.00';
    expect(original.add(money('1.00')).toString()).toBe('11.00');
    expect(original.toString()).toBe('10.00');
    expect(() => Object.assign(original, { currency: 'USD' })).toThrow();
    expect(() => Object.assign(original.toJSON(), { amount: '99.00' })).toThrow();
    expect(Money.rehydrate(original.toJSON()).equals(original)).toBe(true);
  });

  test('does not inherit mutations to global Decimal precision', () => {
    const previous = Decimal.precision;
    try {
      Decimal.set({ precision: 2 });
      expect(money('999999.99').add(money('0.01')).toString()).toBe('1000000.00');
    } finally { Decimal.set({ precision: previous }); }
  });
});
