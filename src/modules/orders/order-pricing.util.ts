import { createHash } from 'node:crypto';

/**
 * Allocates a total discount across line subtotals proportionally,
 * flooring each line's share and giving the leftover (from flooring) to
 * the last line - so the allocations always sum to exactly
 * `totalDiscount`, never a cent more or less. This matters because a
 * partial refund later (Phase 5+) needs to know exactly how much of the
 * order-level discount applied to any one line.
 *
 * Giving the remainder to the last line (rather than the first, or
 * spreading it) is an arbitrary but deterministic tie-break - documented
 * here and in docs/BUSINESS_RULES.md so it reads as a decision, not an
 * accident.
 */
export function allocateDiscount(lineSubtotals: number[], totalDiscount: number): number[] {
  if (lineSubtotals.length === 0) return [];
  if (totalDiscount <= 0) return lineSubtotals.map(() => 0);

  const subtotal = lineSubtotals.reduce((sum, value) => sum + value, 0);
  if (subtotal <= 0) return lineSubtotals.map(() => 0);

  const allocations = lineSubtotals.map((lineSubtotal) =>
    Math.floor((lineSubtotal * totalDiscount) / subtotal),
  );
  const allocatedSum = allocations.reduce((sum, value) => sum + value, 0);
  const remainder = totalDiscount - allocatedSum;
  if (remainder > 0) {
    allocations[allocations.length - 1] += remainder;
  }
  return allocations;
}

/** Human-friendly reference, e.g. "ORD-000123". Never used for access control. */
export function formatOrderNumber(sequenceNumber: number): string {
  return `ORD-${String(sequenceNumber).padStart(6, '0')}`;
}

/**
 * Stable hash of an order-creation request payload, used to detect
 * whether a retried idempotency key carries the exact same request or a
 * different one. Key order in the input object does not matter - values
 * are sorted by key before hashing.
 */
export function hashOrderRequestPayload(payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  const normalized = sortedKeys.map((key) => [key, payload[key]]);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
