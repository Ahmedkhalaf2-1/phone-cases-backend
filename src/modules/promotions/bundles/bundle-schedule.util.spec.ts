import { BadRequestException } from '@nestjs/common';
import { computeBundleStatus, resolveBundleSchedule } from './bundle-schedule.util';

const D = (iso: string) => new Date(iso);
const valid = { startsAt: D('2026-11-01T00:00:00Z'), expiresAt: D('2026-12-01T00:00:00Z') };

describe('resolveBundleSchedule', () => {
  describe('create (no persisted bundle)', () => {
    it('accepts a valid start and end', () => {
      expect(
        resolveBundleSchedule({
          startsAt: '2026-11-01T00:00:00Z',
          expiresAt: '2026-12-01T00:00:00Z',
        }),
      ).toEqual(valid);
    });
    it('accepts start only', () => {
      expect(resolveBundleSchedule({ startsAt: '2026-11-01T00:00:00Z' })).toEqual({
        startsAt: D('2026-11-01T00:00:00Z'),
        expiresAt: undefined,
      });
    });
    it('accepts end only', () => {
      expect(resolveBundleSchedule({ expiresAt: '2026-12-01T00:00:00Z' })).toEqual({
        startsAt: undefined,
        expiresAt: D('2026-12-01T00:00:00Z'),
      });
    });
    it('accepts no dates at all', () => {
      expect(resolveBundleSchedule({})).toEqual({ startsAt: undefined, expiresAt: undefined });
    });
    it('rejects expiresAt before startsAt', () => {
      expect(() =>
        resolveBundleSchedule({
          startsAt: '2026-12-01T00:00:00Z',
          expiresAt: '2026-11-01T00:00:00Z',
        }),
      ).toThrow(BadRequestException);
    });
    it('rejects expiresAt equal to startsAt', () => {
      expect(() =>
        resolveBundleSchedule({
          startsAt: '2026-11-01T00:00:00Z',
          expiresAt: '2026-11-01T00:00:00Z',
        }),
      ).toThrow(BadRequestException);
    });
    it('rejects an unparseable date', () => {
      expect(() => resolveBundleSchedule({ startsAt: 'not-a-date' })).toThrow(BadRequestException);
    });
  });

  describe('patch (against a persisted range)', () => {
    it('leaves dates untouched when the request does not mention them', () => {
      expect(resolveBundleSchedule({}, valid)).toEqual({
        startsAt: undefined,
        expiresAt: undefined,
      });
    });
    it('clears start with null', () => {
      expect(resolveBundleSchedule({ startsAt: null }, valid)).toEqual({
        startsAt: null,
        expiresAt: undefined,
      });
    });
    it('clears end with null', () => {
      expect(resolveBundleSchedule({ expiresAt: null }, valid)).toEqual({
        startsAt: undefined,
        expiresAt: null,
      });
    });
    it('clears both', () => {
      expect(resolveBundleSchedule({ startsAt: null, expiresAt: null }, valid)).toEqual({
        startsAt: null,
        expiresAt: null,
      });
    });
    it('moving only the end later is valid', () => {
      expect(resolveBundleSchedule({ expiresAt: '2027-01-01T00:00:00Z' }, valid).expiresAt).toEqual(
        D('2027-01-01T00:00:00Z'),
      );
    });
    it('rejects moving only the start past the persisted end', () => {
      expect(() => resolveBundleSchedule({ startsAt: '2026-12-15T00:00:00Z' }, valid)).toThrow(
        BadRequestException,
      );
    });
    it('rejects moving only the end before the persisted start', () => {
      expect(() => resolveBundleSchedule({ expiresAt: '2026-10-01T00:00:00Z' }, valid)).toThrow(
        BadRequestException,
      );
    });
    it('rejects setting the end equal to the persisted start', () => {
      expect(() => resolveBundleSchedule({ expiresAt: '2026-11-01T00:00:00Z' }, valid)).toThrow(
        BadRequestException,
      );
    });
    it('allows an end-only bundle to gain a later start-less end after clearing start', () => {
      const endOnly = { startsAt: null, expiresAt: D('2026-12-01T00:00:00Z') };
      expect(resolveBundleSchedule({ startsAt: '2026-11-01T00:00:00Z' }, endOnly).startsAt).toEqual(
        D('2026-11-01T00:00:00Z'),
      );
    });
    it('clearing the start makes an otherwise inverted end valid', () => {
      expect(() =>
        resolveBundleSchedule({ startsAt: null, expiresAt: '2026-10-01T00:00:00Z' }, valid),
      ).not.toThrow();
    });
    it('does not block an unrelated edit of a legacy inverted bundle', () => {
      const legacy = { startsAt: D('2026-12-01T00:00:00Z'), expiresAt: D('2026-11-01T00:00:00Z') };
      expect(() => resolveBundleSchedule({}, legacy)).not.toThrow();
    });
  });
});

describe('computeBundleStatus', () => {
  const now = D('2026-11-15T12:00:00Z');
  const b = (
    o: Partial<{ isEnabled: boolean; startsAt: Date | null; expiresAt: Date | null }>,
  ) => ({
    isEnabled: true,
    startsAt: null,
    expiresAt: null,
    ...o,
  });
  it('is DISABLED whenever not enabled, even inside its window', () => {
    expect(computeBundleStatus(b({ isEnabled: false, ...valid }), now)).toBe('DISABLED');
  });
  it('is ACTIVE with no dates, and inside the window', () => {
    expect(computeBundleStatus(b({}), now)).toBe('ACTIVE');
    expect(computeBundleStatus(b(valid), now)).toBe('ACTIVE');
  });
  it('is SCHEDULED before startsAt and EXPIRED after expiresAt', () => {
    expect(computeBundleStatus(b({ startsAt: D('2027-01-01T00:00:00Z') }), now)).toBe('SCHEDULED');
    expect(computeBundleStatus(b({ expiresAt: D('2026-11-01T00:00:00Z') }), now)).toBe('EXPIRED');
  });
});
