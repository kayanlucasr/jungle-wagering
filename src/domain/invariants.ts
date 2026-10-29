import { DomainError, FailureCode } from './errors/domain-error';

export function assertIdentifier(value: string, maxLength = 256): void {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > maxLength) {
    throw new DomainError(FailureCode.InvalidIdentifier);
  }
}

export function instant(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError(FailureCode.InvalidTimestamp);
  }
  return value.toISOString();
}

export function assertNotBefore(at: string, previous: string): void {
  if (at < previous) throw new DomainError(FailureCode.InvalidTimestamp);
}
