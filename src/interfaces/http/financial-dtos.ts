import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { assertIdentifier } from '../../domain/invariants';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransactionKind as Kind, type ExternalTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import type { SubmitTransaction } from '../../application/financial/payload-hash';

export class RequestValidationError extends BadRequestException {
  constructor(readonly fields: readonly string[]) {
    super('INVALID_REQUEST');
  }
}
export interface CreateWalletDto { readonly playerId: string; readonly initialBalance: MoneyProps }
export type SubmitTransactionDto = Omit<SubmitTransaction, 'idempotencyKey'>;

function record(value: unknown, allowed: readonly string[], required: readonly string[], prefix = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError([prefix || 'body']);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new RequestValidationError([prefix || 'body']);
  const missing = required.filter((key) => !Object.hasOwn(result, key)).map((key) => `${prefix}${key}`);
  if (missing.length > 0) throw new RequestValidationError(missing);
  return result;
}

export function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new RequestValidationError([field]);
  try { assertIdentifier(value); } catch { throw new RequestValidationError([field]); }
  // PostgreSQL TEXT cannot store NUL; lone UTF-16 surrogates would be replaced during UTF-8
  // encoding and change the persisted identity, breaking exact identity/replay comparisons.
  if (value.includes('\u0000') || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new RequestValidationError([field]);
  }
  return value;
}

function money(value: unknown, field: string): MoneyProps {
  const input = record(value, ['amount', 'currency'], ['amount', 'currency'], `${field}.`);
  if (typeof input['amount'] !== 'string') throw new RequestValidationError([`${field}.amount`]);
  if (typeof input['currency'] !== 'string') throw new RequestValidationError([`${field}.currency`]);
  // Money is the authority for precision, range, canonical format and supported currency.
  return Money.from({ amount: input['amount'], currency: input['currency'] }).toJSON();
}

export function createWalletDto(value: unknown): CreateWalletDto {
  const input = record(value, ['playerId', 'initialBalance'], ['playerId', 'initialBalance']);
  return { playerId: identifier(input['playerId'], 'playerId'), initialBalance: money(input['initialBalance'], 'initialBalance') };
}

export function submitTransactionDto(value: unknown): SubmitTransactionDto {
  const required = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'];
  const input = record(value, [...required, 'referenceExternalTransactionId'], required);
  const kind = input['kind'];
  if (typeof kind !== 'string' || kind === Kind.Opening || !Object.values(Kind).includes(kind as Kind)) {
    throw new RequestValidationError(['kind']);
  }
  const reference = input['referenceExternalTransactionId'];
  const needsReference = kind === Kind.Refund || kind === Kind.Rollback;
  if (needsReference && reference === undefined) throw new RequestValidationError(['referenceExternalTransactionId']);
  return {
    providerId: identifier(input['providerId'], 'providerId'),
    externalTransactionId: identifier(input['externalTransactionId'], 'externalTransactionId'),
    walletId: identifier(input['walletId'], 'walletId'), playerId: identifier(input['playerId'], 'playerId'),
    roundId: identifier(input['roundId'], 'roundId'), gameId: identifier(input['gameId'], 'gameId'),
    kind: kind as ExternalTransactionKind, money: money(input['money'], 'money'),
    ...(reference === undefined ? {} : { referenceExternalTransactionId: identifier(reference, 'referenceExternalTransactionId') }),
  };
}

export function idempotencyKey(req: Request): string {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === 'idempotency-key') count += 1;
  }
  const value = req.get('Idempotency-Key');
  if (count !== 1 || typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value)) {
    throw new RequestValidationError(['Idempotency-Key']);
  }
  return value;
}

export function ledgerQuery(value: unknown): { limit: number; cursor?: string } {
  const input = record(value, ['limit', 'cursor'], [], 'query.');
  const rawLimit = input['limit'] ?? '50';
  if (typeof rawLimit !== 'string' || !/^[1-9]\d{0,2}$/.test(rawLimit)) throw new RequestValidationError(['limit']);
  const limit = Number(rawLimit); // Pagination size only; never a monetary value/version.
  if (limit > 100) throw new RequestValidationError(['limit']);
  const cursor = input['cursor'];
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4096)) {
    throw new RequestValidationError(['cursor']);
  }
  return { limit, ...(cursor === undefined ? {} : { cursor: cursor as string }) };
}

export function noQuery(value: unknown): void { record(value, [], [], 'query.'); }
export function noBody(value: unknown): void { if (value !== undefined) record(value, [], []); }
