export enum FailureCode {
  InvalidAmount = 'INVALID_AMOUNT',
  AmountOutOfRange = 'AMOUNT_OUT_OF_RANGE',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  InvalidTransactionState = 'INVALID_TRANSACTION_STATE',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  InvalidWallet = 'INVALID_WALLET',
  InvalidLedgerEntry = 'INVALID_LEDGER_ENTRY',
  InvalidIdentifier = 'INVALID_IDENTIFIER',
  InvalidTimestamp = 'INVALID_TIMESTAMP',
  PermanentProcessingFailure = 'PERMANENT_PROCESSING_FAILURE',
}

/** Stable domain codes, without HTTP status or infrastructure details. */
export class DomainError extends Error {
  constructor(readonly code: FailureCode, message: string = code) {
    super(message);
    this.name = 'DomainError';
    Object.freeze(this);
  }
}
