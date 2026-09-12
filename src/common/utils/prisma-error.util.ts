import { Prisma } from '@prisma/client';

/**
 * Extracts a best-effort identifier for the unique constraint that a
 * P2002 error violated, so callers can branch on which constraint fired
 * without hardcoding a single Prisma error-metadata shape.
 *
 * Prisma's error metadata for P2002 differs by engine: the classic
 * (Rust query engine) shape exposes `meta.target` as a column name or
 * array of column names, while Prisma 7's driver-adapter path
 * (see src/prisma/prisma.service.ts) instead nests the Postgres
 * constraint name under `meta.driverAdapterError.cause.constraint.index`.
 * This checks both and falls back to stringifying whatever is present.
 */
export function getViolatedConstraintName(error: Prisma.PrismaClientKnownRequestError): string {
  const meta = error.meta as
    | {
        target?: unknown;
        driverAdapterError?: { cause?: { constraint?: { index?: string } } };
      }
    | undefined;

  const driverAdapterConstraint = meta?.driverAdapterError?.cause?.constraint?.index;
  if (driverAdapterConstraint) {
    return driverAdapterConstraint;
  }

  const target = meta?.target;
  if (typeof target === 'string') {
    return target;
  }
  if (Array.isArray(target)) {
    return target.join(', ');
  }
  return '';
}
