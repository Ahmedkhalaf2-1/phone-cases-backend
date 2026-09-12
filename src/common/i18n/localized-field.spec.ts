import { pickLocalized } from './localized-field';

describe('pickLocalized', () => {
  it('returns the English value when locale is undefined', () => {
    expect(pickLocalized('Space', 'الفضاء', undefined)).toBe('Space');
  });

  it('returns the Arabic value when locale is "ar" and it is present', () => {
    expect(pickLocalized('Space', 'الفضاء', 'ar')).toBe('الفضاء');
  });

  it('falls back to English when locale is "ar" but the Arabic value is null', () => {
    expect(pickLocalized('Space', null, 'ar')).toBe('Space');
  });

  it('falls back to English when locale is "ar" but the Arabic value is blank', () => {
    expect(pickLocalized('Space', '   ', 'ar')).toBe('Space');
  });

  it('returns the English value when locale is "en" even if Arabic is present', () => {
    expect(pickLocalized('Space', 'الفضاء', 'en')).toBe('Space');
  });
});
