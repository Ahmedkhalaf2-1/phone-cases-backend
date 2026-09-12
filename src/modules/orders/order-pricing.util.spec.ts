import { allocateDiscount, formatOrderNumber, hashOrderRequestPayload } from './order-pricing.util';

describe('allocateDiscount', () => {
  it('allocates proportionally and sums to exactly the total discount', () => {
    const allocations = allocateDiscount([3000, 7000], 1000);
    expect(allocations).toEqual([300, 700]);
    expect(allocations.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('gives the flooring remainder to the last line', () => {
    // 999 split 1/3, 1/3, 1/3 of a 10 discount -> 3.33 each, floors to 3,
    // remainder 1 goes to the last line.
    const allocations = allocateDiscount([333, 333, 333], 10);
    expect(allocations).toEqual([3, 3, 4]);
    expect(allocations.reduce((a, b) => a + b, 0)).toBe(10);
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
