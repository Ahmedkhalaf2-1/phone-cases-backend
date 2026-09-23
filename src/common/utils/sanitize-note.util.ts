import { BadRequestException } from '@nestjs/common';

export const CART_ITEM_NOTE_MAX_LENGTH = 500;

// Strips ASCII/Latin-1 control characters (kept: \t and \n, so a note can
// still span lines) from guest-supplied free text before it is persisted
// and later rendered as-is in the admin order view.
// eslint-disable-next-line no-control-regex -- intentionally matching control characters to strip them
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Normalizes a cart-item customization note: strips control characters,
 * trims surrounding whitespace, and treats an empty result as no note at
 * all (`null`) rather than an empty string. `undefined` (field omitted
 * entirely) passes through unchanged so callers can distinguish "leave
 * the existing note alone" from "clear it".
 */
export function sanitizeCartItemNote(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const cleaned = raw.replace(CONTROL_CHAR_PATTERN, '').trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > CART_ITEM_NOTE_MAX_LENGTH) {
    throw new BadRequestException(`note must not exceed ${CART_ITEM_NOTE_MAX_LENGTH} characters`);
  }
  return cleaned;
}
