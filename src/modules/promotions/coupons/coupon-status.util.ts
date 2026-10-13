export type CouponStatus = 'DISABLED' | 'SCHEDULED' | 'EXPIRED' | 'EXHAUSTED' | 'ACTIVE';

/**
 * Admin-facing lifecycle state. Mirrors the checks in
 * findCouponValidityError (cart-pricing.service.ts) - inactive, not yet
 * started, expired, usage limit reached - so the list can never say
 * "Active" for a coupon the cart would refuse. The minimum-spend rule is
 * deliberately not part of status: it depends on a cart, not the coupon.
 */
export function computeCouponStatus(
  coupon: {
    isActive: boolean;
    startsAt: Date | null;
    expiresAt: Date | null;
    usageLimit: number | null;
    usageCount: number;
  },
  now: Date = new Date(),
): CouponStatus {
  if (!coupon.isActive) return 'DISABLED';
  if (coupon.startsAt && coupon.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  if (coupon.expiresAt && coupon.expiresAt.getTime() < now.getTime()) return 'EXPIRED';
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) return 'EXHAUSTED';
  return 'ACTIVE';
}
