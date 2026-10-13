import { BadRequestException } from '@nestjs/common';

export interface ScheduleWindowInput {
  /** undefined = leave unchanged, null = clear, string = set. */
  startsAt?: string | null;
  expiresAt?: string | null;
}

export interface ScheduleWindowWrite {
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
 * Resolves a create/patch schedule window (startsAt/expiresAt) into Prisma-ready
 * writes and enforces
 * `expiresAt > startsAt` against the *effective* range: a side that is not
 * part of the request falls back to the persisted value, so a PATCH that
 * only moves one end cannot silently produce an inverted window.
 *
 * Validation only runs when the request touches a date, so an unrelated
 * edit (rename, toggle) to a legacy record is never blocked by old data.
 * Shared by bundles and coupons.
 */
export function resolveScheduleWindow(
  input: ScheduleWindowInput,
  existing: { startsAt: Date | null; expiresAt: Date | null } | null = null,
): ScheduleWindowWrite {
  const write: ScheduleWindowWrite = {
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
