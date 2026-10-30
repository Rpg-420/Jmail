import { sqliteDateTime } from './utils';

/**
 * Retry ladders for the send queue and outbound webhooks, kept in one place
 * so the two never drift and neither module has to import the other.
 */

const SEND_DELAYS_MS = [
  30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
  60 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000,
];

const WEBHOOK_DELAYS_MS = [
  15_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000, 48 * 3_600_000,
];

export const MAX_SEND_ATTEMPTS = SEND_DELAYS_MS.length;
export const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_DELAYS_MS.length;

/**
 * How long a drain holds one row. Longer than any plausible tick, so two
 * overlapping crons cannot post the same mail twice, and short enough that a
 * Worker killed mid-send leaves the row retryable instead of stranded.
 */
export const DRAIN_LEASE_SECONDS = 10 * 60;

export function sendRetryDelayMs(attempts: number): number {
  return SEND_DELAYS_MS[Math.min(Math.max(attempts, 1), SEND_DELAYS_MS.length) - 1];
}

export function webhookRetryDelayMs(attempts: number): number {
  return WEBHOOK_DELAYS_MS[Math.min(Math.max(attempts, 1), WEBHOOK_DELAYS_MS.length) - 1];
}

export function retryAt(delayMs: number): string {
  return sqliteDateTime(new Date(Date.now() + delayMs));
}

export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
