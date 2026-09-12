import { allocateDiscount, formatOrderNumber, hashOrderRequestPayload } from './order-pricing.util';

describe('allocateDiscount', () => {
  it('allocates proportionally and sums to exactly the total discount', () => {
    const allocations = allocateDiscount([3000, 7000], 1000);
    expect(allocations).toEqual([300, 700]);
    expect(allocations.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('gives the flooring remainder to the first line with headroom', () => {
    // 999 split 1/3, 1/3, 1/3 of a 10 discount -> 3.33 each, floors to 3,
    // remainder 1 goes to the first line that still has room (index 0),
    // not unconditionally to the last line.
    const allocations = allocateDiscount([333, 333, 333], 10);
    expect(allocations).toEqual([4, 3, 3]);
    expect(allocations.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('never lets a single line exceed its own subtotal, even when the naive last-line remainder would', () => {
    // Under the old "remainder always goes to the last line" rule, this
    // returned [0, 0, 2] - giving the third line a discount TWICE its own
    // 1-unit subtotal. Each line's allocation must stay within its own
    // subtotal no matter which lines absorb the flooring remainder.
    const allocations = allocateDiscount([1, 1, 1], 2);
    expect(allocations.reduce((a, b) => a + b, 0)).toBe(2);
    allocations.forEach((allocation, index) => {
      expect(allocation).toBeLessThanOrEqual([1, 1, 1][index]);
    });
  });

  it('caps the total discount at the sum of line subtotals defensively', () => {
    const allocations = allocateDiscount([100, 200], 10_000);
    expect(allocations).toEqual([100, 200]);
    expect(allocations.reduce((a, b) => a + b, 0)).toBe(300);
  });

  it('returns all zeros when there is no discount', () => {
    expect(allocateDiscount([1000, 2000], 0)).toEqual([0, 0]);
  });

  it('returns an empty array for no lines', () => {
    expect(allocateDiscount([], 500)).toEqual([]);
  });
});

describe('formatOrderNumber', () => {
  it('pads to 6 digits with an ORD- prefix', () => {
    expect(formatOrderNumber(1)).toBe('ORD-000001');
    expect(formatOrderNumber(123456)).toBe('ORD-123456');
  });
});

describe('hashOrderRequestPayload', () => {
  it('produces the same hash regardless of key order', () => {
    const a = hashOrderRequestPayload({ x: 1, y: 2 });
    const b = hashOrderRequestPayload({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it('produces a different hash for different values', () => {
    const a = hashOrderRequestPayload({ x: 1 });
    const b = hashOrderRequestPayload({ x: 2 });
    expect(a).not.toBe(b);
  });
});
