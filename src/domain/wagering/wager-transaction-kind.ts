export enum WagerTransactionKind {
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK',
}

export type ExternalTransactionKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
