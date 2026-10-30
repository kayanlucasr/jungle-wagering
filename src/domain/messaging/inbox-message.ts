import { assertIdentifier, instant } from '../invariants';

export interface InboxMessageState {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  readonly transactionId: string | null;
  readonly processedAt: Date | null;
}

/** A committed inbox result is terminal. SQL remains responsible for cross-process exclusion. */
export class InboxMessage {
  private constructor(readonly messageId: string, readonly consumerName: string, readonly payloadHash: string,
    private readonly received: string, readonly transactionId: string | null, private readonly processed: string | null) {
    Object.freeze(this);
  }
  static receive(props: Omit<InboxMessageState, 'transactionId' | 'processedAt'>): InboxMessage {
    return this.rehydrate({ ...props, transactionId: null, processedAt: null });
  }
  static rehydrate(state: InboxMessageState): InboxMessage {
    assertIdentifier(state.messageId); assertIdentifier(state.consumerName);
    if (!/^[a-f0-9]{64}$/.test(state.payloadHash)) throw new Error('InvalidInboxHash');
    const received = instant(state.receivedAt);
    const processed = state.processedAt === null ? null : instant(state.processedAt);
    if (state.transactionId !== null) assertIdentifier(state.transactionId);
    if (processed !== null && (state.transactionId === null || processed < received)) throw new Error('InvalidInboxState');
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, received, state.transactionId, processed);
  }
  get receivedAt(): Date { return new Date(this.received); }
  get processedAt(): Date | null { return this.processed === null ? null : new Date(this.processed); }
  isProcessed(): boolean { return this.processed !== null; }
  markProcessed(transactionId: string, at: Date): InboxMessage {
    if (this.isProcessed()) throw new Error('InboxAlreadyProcessed');
    if (this.transactionId !== null && this.transactionId !== transactionId) throw new Error('InboxTransactionConflict');
    return InboxMessage.rehydrate({ messageId: this.messageId, consumerName: this.consumerName,
      payloadHash: this.payloadHash, receivedAt: this.receivedAt, transactionId, processedAt: at });
  }
}
