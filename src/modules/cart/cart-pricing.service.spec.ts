import { CouponType } from '@prisma/client';
import { computeDiscount, findCouponValidityError } from './cart-pricing.service';

describe('computeDiscount', () => {
  it('applies a FIXED discount up to the subtotal', () => {
    expect(computeDiscount({ type: CouponType.FIXED, value: 5000 }, 20000)).toBe(5000);
  });

  it('clamps a FIXED discount larger than the subtotal', () => {
    expect(computeDiscount({ type: CouponType.FIXED, value: 50000 }, 20000)).toBe(20000);
  });

  it('rounds a PERCENTAGE discount down', () => {
    // 10% of 999 = 99.9, must round down to 99, never up.
    expect(computeDiscount({ type: CouponType.PERCENTAGE, value: 10 }, 999)).toBe(99);
  });

  it('returns 0 for a zero or negative subtotal', () => {
    expect(computeDiscount({ type: CouponType.PERCENTAGE, value: 50 }, 0)).toBe(0);
  });
});

describe('findCouponValidityError', () => {
  const baseCoupon = {
    isActive: true,
    startsAt: null,
    expiresAt: null,
    minSpend: null,
    usageLimit: null,
    usageCount: 0,
  };

  it('accepts a coupon with no restrictions', () => {
    expect(findCouponValidityError(baseCoupon, 1000)).toBeUndefined();
  });

  it('rejects an inactive coupon', () => {
    expect(findCouponValidityError({ ...baseCoupon, isActive: false }, 1000)).toBeDefined();
  });

  it('rejects a coupon that has not started yet', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const startsAt = new Date('2026-06-01T00:00:00Z');
    expect(findCouponValidityError({ ...baseCoupon, startsAt }, 1000, now)).toBeDefined();
  });

  it('rejects an expired coupon', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const expiresAt = new Date('2026-01-01T00:00:00Z');
    expect(findCouponValidityError({ ...baseCoupon, expiresAt }, 1000, now)).toBeDefined();
  });

  it('rejects when subtotal is below minSpend', () => {
    expect(findCouponValidityError({ ...baseCoupon, minSpend: 5000 }, 4999)).toBeDefined();
  });

  it('accepts when subtotal exactly meets minSpend', () => {
    expect(findCouponValidityError({ ...baseCoupon, minSpend: 5000 }, 5000)).toBeUndefined();
  });

  it('rejects when usageCount has reached usageLimit', () => {
    expect(
      findCouponValidityError({ ...baseCoupon, usageLimit: 10, usageCount: 10 }, 1000),
    ).toBeDefined();
  });

  it('accepts when usageCount is below usageLimit', () => {
    expect(
      findCouponValidityError({ ...baseCoupon, usageLimit: 10, usageCount: 9 }, 1000),
    ).toBeUndefined();
  });
});
