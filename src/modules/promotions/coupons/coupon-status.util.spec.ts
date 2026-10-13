import { computeCouponStatus } from './coupon-status.util';

const now = new Date('2026-11-15T12:00:00Z');
const D = (iso: string) => new Date(iso);
const base = { isActive: true, startsAt: null, expiresAt: null, usageLimit: null, usageCount: 0 };

describe('computeCouponStatus', () => {
  it('is ACTIVE with no restrictions, and inside its window', () => {
    expect(computeCouponStatus(base, now)).toBe('ACTIVE');
    expect(
      computeCouponStatus(
        { ...base, startsAt: D('2026-11-01T00:00:00Z'), expiresAt: D('2026-12-01T00:00:00Z') },
        now,
      ),
    ).toBe('ACTIVE');
  });
  it('is DISABLED whenever isActive is false, whatever else is true', () => {
    expect(
      computeCouponStatus({ ...base, isActive: false, expiresAt: D('2020-01-01T00:00:00Z') }, now),
    ).toBe('DISABLED');
  });
  it('is SCHEDULED before startsAt and EXPIRED after expiresAt', () => {
    expect(computeCouponStatus({ ...base, startsAt: D('2027-01-01T00:00:00Z') }, now)).toBe(
      'SCHEDULED',
    );
    expect(computeCouponStatus({ ...base, expiresAt: D('2026-11-01T00:00:00Z') }, now)).toBe(
      'EXPIRED',
    );
  });
  it('is EXHAUSTED once usageCount reaches usageLimit, but not before', () => {
    expect(computeCouponStatus({ ...base, usageLimit: 5, usageCount: 4 }, now)).toBe('ACTIVE');
    expect(computeCouponStatus({ ...base, usageLimit: 5, usageCount: 5 }, now)).toBe('EXHAUSTED');
    expect(computeCouponStatus({ ...base, usageLimit: 5, usageCount: 9 }, now)).toBe('EXHAUSTED');
  });
  it('prefers EXPIRED over EXHAUSTED', () => {
    expect(
      computeCouponStatus(
        { ...base, expiresAt: D('2026-11-01T00:00:00Z'), usageLimit: 1, usageCount: 1 },
        now,
      ),
    ).toBe('EXPIRED');
  });
});
