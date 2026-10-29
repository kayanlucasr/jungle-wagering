export class PendingReferenceMetrics {
  active = 0;
  attempts = 0;
  resolved = 0;
  rejected = 0;
  expired = 0;
  transientFailures = 0;
  processingDurationMs = 0;
  completedCount = 0;
  resolutionAgeMs = 0;
  snapshot(): Readonly<Record<string, number>> {
    return { ...Object.fromEntries(Object.entries(this).filter((entry): entry is [string, number] => typeof entry[1] === 'number')),
      meanResolutionMs: this.completedCount === 0 ? 0 : this.resolutionAgeMs / this.completedCount };
  }
}
