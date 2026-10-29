export class MessagingMetrics {
  received = 0;
  processed = 0;
  duplicates = 0;
  transientFailures = 0;
  invalid = 0;
  permanentFailures = 0;
  dlqForwarded = 0;
  published = 0;
  publicationFailures = 0;
  outboxPending = 0;
  outboxExhausted = 0;
  outboxOldestAgeMs = 0;
  processingDurationMs = 0;
  processingCount = 0;
  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(Object.entries(this).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  }
}
