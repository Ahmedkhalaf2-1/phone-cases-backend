import { BadRequestException } from '@nestjs/common';
import { CART_ITEM_NOTE_MAX_LENGTH, sanitizeCartItemNote } from './sanitize-note.util';

describe('sanitizeCartItemNote', () => {
  it('passes undefined through unchanged (field omitted)', () => {
    expect(sanitizeCartItemNote(undefined)).toBeUndefined();
  });

  it('passes an explicit null through unchanged (clears the note)', () => {
    expect(sanitizeCartItemNote(null)).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeCartItemNote('  put in a black box  ')).toBe('put in a black box');
  });

  it('treats an empty or whitespace-only string as null', () => {
    expect(sanitizeCartItemNote('')).toBeNull();
    expect(sanitizeCartItemNote('   ')).toBeNull();
  });

  it('strips control characters but keeps newlines and tabs', () => {
    expect(sanitizeCartItemNote('line one\nline\ttwo\x00\x1F')).toBe('line one\nline\ttwo');
  });

  it('rejects a note longer than the max length after trimming', () => {
    const tooLong = 'a'.repeat(CART_ITEM_NOTE_MAX_LENGTH + 1);
    expect(() => sanitizeCartItemNote(tooLong)).toThrow(BadRequestException);
  });

  it('accepts a note exactly at the max length', () => {
    const exact = 'a'.repeat(CART_ITEM_NOTE_MAX_LENGTH);
    expect(sanitizeCartItemNote(exact)).toBe(exact);
  });

  it('allows whitespace padding that only exceeds the limit before trimming', () => {
    const padded = `  ${'a'.repeat(CART_ITEM_NOTE_MAX_LENGTH)}  `;
    expect(sanitizeCartItemNote(padded)).toBe('a'.repeat(CART_ITEM_NOTE_MAX_LENGTH));
  });
});
