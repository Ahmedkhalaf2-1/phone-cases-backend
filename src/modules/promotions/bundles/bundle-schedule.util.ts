import { BadRequestException } from '@nestjs/common';

export interface BundleScheduleInput {
  /** undefined = leave unchanged, null = clear, string = set. */
  startsAt?: string | null;
  expiresAt?: string | null;
}

export interface BundleScheduleWrite {
  /** undefined = leave unchanged, null = clear, Date = set. */
  startsAt: Date | null | undefined;
  expiresAt: Date | null | undefined;
}

function toWrite(value: string | null | undefined, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  return date;
}

/**
 * Resolves a create/patch schedule into Prisma-ready writes and enforces
 * `expiresAt > startsAt` against the *effective* range: a side that is not
 * part of the request falls back to the persisted value, so a PATCH that
 * only moves one end cannot silently produce an inverted window.
 *
 * Validation only runs when the request touches a date, so an unrelated
 * edit (rename, toggle) to a legacy bundle is never blocked by old data.
 */
export function resolveBundleSchedule(
  input: BundleScheduleInput,
  existing: { startsAt: Date | null; expiresAt: Date | null } | null = null,
): BundleScheduleWrite {
  const write: BundleScheduleWrite = {
    startsAt: toWrite(input.startsAt, 'startsAt'),
    expiresAt: toWrite(input.expiresAt, 'expiresAt'),
  };

  if (write.startsAt === undefined && write.expiresAt === undefined) {
    return write;
  }

  const effectiveStart =
    write.startsAt !== undefined ? write.startsAt : (existing?.startsAt ?? null);
  const effectiveEnd =
    write.expiresAt !== undefined ? write.expiresAt : (existing?.expiresAt ?? null);

  if (effectiveStart && effectiveEnd && effectiveEnd.getTime() <= effectiveStart.getTime()) {
    throw new BadRequestException('expiresAt must be later than startsAt');
  }
  return write;
}

export type BundleStatus = 'DISABLED' | 'SCHEDULED' | 'ACTIVE' | 'EXPIRED';

/**
 * Admin-facing lifecycle state, using the exact same window the pricing
 * query applies (startsAt <= now <= expiresAt) so the list can never claim
 * "Active" for a bundle that checkout is not applying.
 */
export function computeBundleStatus(
  bundle: { isEnabled: boolean; startsAt: Date | null; expiresAt: Date | null },
  now: Date = new Date(),
): BundleStatus {
  if (!bundle.isEnabled) return 'DISABLED';
  if (bundle.startsAt && bundle.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  if (bundle.expiresAt && bundle.expiresAt.getTime() < now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}
