import { createHash } from 'node:crypto';

/**
 * Allocates a total discount across line subtotals proportionally,
 * flooring each line's share, so the allocations always sum to exactly
 * `totalDiscount`, never a cent more or less. This matters because a
 * partial refund later needs to know exactly how much of the order-level
 * discount applied to any one line.
 *
 * `totalDiscount` is defensively capped at the sum of `lineSubtotals` -
 * callers must never rely on this cap to make an over-large discount
 * "safe"; it exists only so this function can never itself hand back
 * allocations that sum to more than the eligible amount even if a caller
 * ever passes one.
 *
 * The flooring remainder (always < lineSubtotals.length, so strictly
 * smaller than the number of lines) is distributed one minor unit at a
 * time to lines that still have headroom (`allocation[i] <
 * lineSubtotals[i]`), scanning in array order - NOT dumped entirely onto
 * the last line. That older rule could push a single line's allocation
 * *above its own subtotal* whenever that line happened to be small and
 * several other lines' fractional losses accumulated onto it (e.g.
 * `allocateDiscount([1, 1, 1], 2)` used to return `[0, 0, 2]`, giving the
 * third line a discount twice its own price) - a genuine, previously
 * undetected violation of "a discount can never exceed its own eligible
 * amount." Distributing the remainder to whichever lines still have room
 * is guaranteed to succeed without exceeding any line's cap: the total
 * headroom across all lines (`sum(lineSubtotals) - flooredSum`) is always
 * at least the remainder whenever `totalDiscount <= sum(lineSubtotals)`,
 * which the cap above guarantees. See docs/BUSINESS_RULES.md and
 * docs/DECISIONS.md for the incident this replaced.
 */
export function allocateDiscount(lineSubtotals: number[], totalDiscount: number): number[] {
  if (lineSubtotals.length === 0) return [];
  if (totalDiscount <= 0) return lineSubtotals.map(() => 0);

  const subtotal = lineSubtotals.reduce((sum, value) => sum + value, 0);
  if (subtotal <= 0) return lineSubtotals.map(() => 0);

  const cappedTotal = Math.min(totalDiscount, subtotal);

  const allocations = lineSubtotals.map((lineSubtotal) =>
    Math.min(lineSubtotal, Math.floor((lineSubtotal * cappedTotal) / subtotal)),
  );
  const allocatedSum = allocations.reduce((sum, value) => sum + value, 0);
  let remainder = cappedTotal - allocatedSum;

  let index = 0;
  while (remainder > 0 && index < allocations.length) {
    if (allocations[index] < lineSubtotals[index]) {
      allocations[index] += 1;
      remainder -= 1;
    } else {
      index += 1;
    }
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
