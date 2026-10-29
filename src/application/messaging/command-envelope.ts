import { createHash, randomUUID } from 'node:crypto';
import { assertIdentifier } from '../../domain/invariants';
import { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { payloadHash, type SubmitTransaction } from '../financial/payload-hash';

export interface CommandEnvelope {
  readonly messageId: string;
  readonly type: 'WagerTransactionRequested';
  readonly version: 1;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly data: SubmitTransaction;
}
export class InvalidEnvelope extends Error { constructor() { super('INVALID_ENVELOPE'); } }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidEnvelope();
  const record = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))) throw new InvalidEnvelope();
  return record;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000') || Buffer.from(value).toString() !== value) throw new InvalidEnvelope();
  assertIdentifier(value);
  return value;
}
export function parseCommand(body: string | undefined): CommandEnvelope {
  try {
    if (body === undefined || Buffer.byteLength(body) > 65536) throw new InvalidEnvelope();
    const e = object(JSON.parse(body), ['messageId', 'type', 'version', 'correlationId', 'occurredAt', 'data']);
    if (e['type'] !== 'WagerTransactionRequested' || e['version'] !== 1
      || typeof e['occurredAt'] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e['occurredAt'])
      || new Date(e['occurredAt']).toISOString() !== e['occurredAt']) throw new InvalidEnvelope();
    const d = object(e['data'], ['providerId', 'externalTransactionId', 'idempotencyKey', 'walletId',
      'playerId', 'roundId', 'gameId', 'kind', 'money'], ['referenceExternalTransactionId']);
    const m = object(d['money'], ['amount', 'currency']);
    if (typeof m['amount'] !== 'string' || typeof m['currency'] !== 'string') throw new InvalidEnvelope();
    const command: SubmitTransaction = { providerId: identifier(d['providerId']),
      externalTransactionId: identifier(d['externalTransactionId']), idempotencyKey: identifier(d['idempotencyKey']),
      walletId: identifier(d['walletId']), playerId: identifier(d['playerId']), roundId: identifier(d['roundId']),
      gameId: identifier(d['gameId']), kind: d['kind'] as SubmitTransaction['kind'],
      money: Money.from({ amount: m['amount'], currency: m['currency'] }).toJSON(),
      ...(d['referenceExternalTransactionId'] === undefined ? {} : {
        referenceExternalTransactionId: identifier(d['referenceExternalTransactionId']) }) };
    WagerTransaction.create({ ...command, id: randomUUID(), money: Money.from(command.money),
      payloadHash: payloadHash(command), at: new Date() });
    const correlationId = identifier(e['correlationId']);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)) throw new InvalidEnvelope();
    return Object.freeze({ messageId: identifier(e['messageId']), type: 'WagerTransactionRequested',
      version: 1, correlationId, occurredAt: e['occurredAt'], data: Object.freeze(command) });
  } catch { throw new InvalidEnvelope(); }
}
export function commandHash(e: CommandEnvelope): string {
  return createHash('sha256').update(JSON.stringify([e.version, e.messageId, e.type, e.correlationId,
    e.occurredAt, e.data.idempotencyKey, payloadHash(e.data)])).digest('hex');
}
/** Wallet-scoped, ASCII and <=128 chars, including Unicode business IDs. */
export function walletGroup(walletId: string): string { return createHash('sha256').update(walletId).digest('hex'); }
