import { FinancialError } from './errors';

export interface LedgerPosition { readonly afterVersion: bigint; readonly upperVersion: bigint }
const maxVersion = 9223372036854775807n;

/** Opaque, versioned continuation token. It is pagination state, never an authorization token. */
export function decodeLedgerCursor(cursor: string, walletId: string): LedgerPosition {
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    const state: unknown = JSON.parse(decoded.toString('utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error();
    const record = state as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'after,upper,v,walletId' || record['v'] !== 1
      || record['walletId'] !== walletId || typeof record['after'] !== 'string'
      || typeof record['upper'] !== 'string' || !/^[1-9]\d{0,18}$/.test(record['after'])
      || !/^[1-9]\d{0,18}$/.test(record['upper'])) throw new Error();
    const afterVersion = BigInt(record['after']);
    const upperVersion = BigInt(record['upper']);
    if (afterVersion >= upperVersion || upperVersion > maxVersion) throw new Error();
    return { afterVersion, upperVersion };
  } catch { throw new FinancialError('INVALID_CURSOR'); }
}

export function encodeLedgerCursor(walletId: string, afterVersion: bigint, upperVersion: bigint): string {
  return Buffer.from(JSON.stringify({ v: 1, walletId, after: afterVersion.toString(), upper: upperVersion.toString() }), 'utf8').toString('base64url');
}
