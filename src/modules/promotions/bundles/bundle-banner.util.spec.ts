import { BundleScope } from '@prisma/client';
import {
  CATALOG_HREF,
  cleanBannerField,
  defaultBannerText,
  resolveBannerTarget,
} from './bundle-banner.util';

describe('defaultBannerText', () => {
  it('formats whole amounts without decimals, uppercase', () => {
    expect(defaultBannerText(2, 45000, 'EGP')).toBe('2 CASES FOR 450 EGP');
    expect(defaultBannerText(3, 99900, 'egp')).toBe('3 CASES FOR 999 EGP');
  });
  it('keeps two decimals for fractional amounts', () => {
    expect(defaultBannerText(2, 45050, 'EGP')).toBe('2 CASES FOR 450.50 EGP');
  });
});

describe('cleanBannerField', () => {
  it('trims and maps blank to null', () => {
    expect(cleanBannerField('  SHOP NOW ')).toBe('SHOP NOW');
    expect(cleanBannerField('   ')).toBeNull();
    expect(cleanBannerField(undefined)).toBeNull();
    expect(cleanBannerField(null)).toBeNull();
  });
});

describe('resolveBannerTarget', () => {
  it('sends a single collection to its page', () => {
    expect(resolveBannerTarget(BundleScope.COLLECTIONS, ['summer'], [])).toEqual({
      type: 'COLLECTION',
      href: '/collections/summer',
    });
  });
  it('sends a single product to its page', () => {
    expect(resolveBannerTarget(BundleScope.PRODUCTS, [], ['art-1'])).toEqual({
      type: 'PRODUCT',
      href: '/products/art-1',
    });
  });
  it('falls back to the catalog for broad or ambiguous scopes', () => {
    for (const scope of [
      BundleScope.ALL_PRODUCTS,
      BundleScope.CASE_TYPES,
      BundleScope.PHONE_BRANDS,
      BundleScope.PHONE_MODELS,
      BundleScope.SPECIFIC_VARIANTS,
    ]) {
      expect(resolveBannerTarget(scope, ['a'], ['b'])).toEqual({
        type: 'CATALOG',
        href: CATALOG_HREF,
      });
    }
    expect(resolveBannerTarget(BundleScope.COLLECTIONS, ['a', 'b'], []).type).toBe('CATALOG');
    expect(resolveBannerTarget(BundleScope.COLLECTIONS, [], []).type).toBe('CATALOG');
    expect(resolveBannerTarget(BundleScope.PRODUCTS, [], ['a', 'b']).type).toBe('CATALOG');
  });
});
