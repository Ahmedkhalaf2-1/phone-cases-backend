export type Locale = 'en' | 'ar';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ar'];
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Picks the localized value for `locale`, falling back to English (the
 * required field) when an Arabic value is missing or blank. English is
 * always required at write time, so it is always available as a fallback -
 * see docs/DATA_MODEL.md "Bilingual fields" for the write-time rules.
 */
export function pickLocalized(
  en: string,
  ar: string | null | undefined,
  locale: Locale | undefined,
): string {
  if (locale === 'ar' && ar && ar.trim().length > 0) {
    return ar;
  }
  return en;
}

export function isValidLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as string[]).includes(value);
}
