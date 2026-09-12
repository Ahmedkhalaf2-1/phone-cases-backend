import { BadRequestException } from '@nestjs/common';

// Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits, in order,
// mapped to their Western equivalents.
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function toWesternDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = ARABIC_INDIC_DIGITS.indexOf(digit);
    if (arabicIndex !== -1) return String(arabicIndex);
    const extendedIndex = EXTENDED_ARABIC_INDIC_DIGITS.indexOf(digit);
    return String(extendedIndex);
  });
}

/**
 * Normalizes a customer-entered phone number for storage: converts
 * Arabic-Indic/Extended Arabic-Indic digits to Western digits, strips
 * spaces/dashes/parentheses, and validates the result is plausible.
 *
 * Only Egyptian numbers are validated against a specific pattern - this
 * is a single-market MVP (DEFAULT_CURRENCY=EGP; see docs/DECISIONS.md).
 * Any other country's number is digit-normalized but only checked for a
 * generic "digits and an optional leading +" shape, not validated against
 * that country's real numbering plan. This is an explicit, documented
 * limitation, not a silent gap - extend this function with per-country
 * rules if/when the business actually ships to another country.
 */
export function normalizePhoneNumber(rawPhone: string, countryCode: string): string {
  const westernDigits = toWesternDigits(rawPhone.trim());
  const stripped = westernDigits.replace(/[\s\-().]/g, '');

  if (!/^\+?\d{6,15}$/.test(stripped)) {
    throw new BadRequestException(
      'Phone number must contain only digits (Western or Arabic-Indic), an optional leading "+", and be 6-15 digits long',
    );
  }

  if (countryCode.toUpperCase() === 'EG') {
    // Egyptian mobile numbers: 11 digits starting with 01, optionally
    // prefixed with the country code (+20 or 20), e.g. 01012345678 or
    // +201012345678.
    const withoutCountryCode = stripped.replace(/^\+?20/, '0');
    if (!/^01[0125]\d{8}$/.test(withoutCountryCode)) {
      throw new BadRequestException(
        'For Egypt, phone number must be a valid 11-digit mobile number starting with 010, 011, 012 or 015',
      );
    }
    return withoutCountryCode;
  }

  return stripped;
}
