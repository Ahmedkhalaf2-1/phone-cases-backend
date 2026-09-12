import { BadRequestException } from '@nestjs/common';
import { normalizePhoneNumber } from './phone.util';

describe('normalizePhoneNumber', () => {
  it('normalizes a valid Egyptian mobile number as-is', () => {
    expect(normalizePhoneNumber('01012345678', 'EG')).toBe('01012345678');
  });

  it('converts Arabic-Indic digits to Western digits', () => {
    expect(normalizePhoneNumber('٠١٠١٢٣٤٥٦٧٨', 'EG')).toBe('01012345678');
  });

  it('strips spaces and dashes', () => {
    expect(normalizePhoneNumber('010-1234-5678', 'EG')).toBe('01012345678');
  });

  it('accepts an Egyptian number with a +20 country code prefix', () => {
    expect(normalizePhoneNumber('+201012345678', 'EG')).toBe('01012345678');
  });

  it('accepts an Egyptian number with a bare 20 country code prefix', () => {
    expect(normalizePhoneNumber('201012345678', 'EG')).toBe('01012345678');
  });

  it('rejects an Egyptian number with the wrong prefix', () => {
    expect(() => normalizePhoneNumber('09012345678', 'EG')).toThrow(BadRequestException);
  });

  it('rejects an Egyptian number with the wrong length', () => {
    expect(() => normalizePhoneNumber('010123', 'EG')).toThrow(BadRequestException);
  });

  it('rejects a value with letters', () => {
    expect(() => normalizePhoneNumber('010abc45678', 'EG')).toThrow(BadRequestException);
  });

  it('digit-normalizes but does not apply Egypt-specific validation for other countries', () => {
    expect(normalizePhoneNumber('+1 202-555-0173', 'US')).toBe('+12025550173');
  });
});
