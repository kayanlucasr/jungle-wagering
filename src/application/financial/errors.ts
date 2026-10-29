export type FinancialErrorCode = 'IDEMPOTENCY_CONFLICT' | 'WALLET_ALREADY_EXISTS'
  | 'PERSISTENCE_INTEGRITY' | 'WALLET_VERSION_EXHAUSTED' | 'PERSISTENCE_UNAVAILABLE' | 'UNSAFE_DATABASE_ROLE'
  | 'TRANSACTION_NOT_FOUND' | 'INVALID_CURSOR';

/** No driver message, SQL, credentials or payload is exposed through application errors. */
export class FinancialError extends Error {
  constructor(readonly code: FinancialErrorCode) { super(code); this.name = 'FinancialError'; }
}
