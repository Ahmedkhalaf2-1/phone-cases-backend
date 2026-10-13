import { BundleScope } from '@prisma/client';

/** Max lengths enforced by the DTO; the banner is a single slim line. */
export const MAX_BANNER_TEXT = 80;
export const MAX_BANNER_CTA = 24;
export const DEFAULT_BANNER_CTA = 'SHOP NOW';

/** Storefront routes a banner may point to. Public-safe slugs only. */
export const CATALOG_HREF = '/collections';

export interface AnnouncementBannerTarget {
  type: 'CATALOG' | 'COLLECTION' | 'PRODUCT';
  href: string;
}

export interface AnnouncementBanner {
  enabled: true;
  text: string;
  ctaLabel: string;
  target: AnnouncementBannerTarget;
}

/** "2 CASES FOR 450 EGP" - amounts are minor units; whole amounts have no decimals. */
export function defaultBannerText(
  bundleSize: number,
  fixedTotal: number,
  currency: string,
): string {
  const amount = fixedTotal / 100;
  const price = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${bundleSize} CASES FOR ${price} ${currency}`.toUpperCase();
}

/** Trims; an empty/blank value means "not set". */
export function cleanBannerField(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Where a banner click should land, derived from the bundle's scope using
 * only public slugs. `collectionSlugs` / `productSlugs` must already be
 * limited to publicly visible rows (active collections / published products).
 * One clear target -> its page; anything broader -> the catalog.
 */
export function resolveBannerTarget(
  scope: BundleScope,
  collectionSlugs: string[],
  productSlugs: string[],
): AnnouncementBannerTarget {
  if (scope === BundleScope.COLLECTIONS && collectionSlugs.length === 1) {
    return { type: 'COLLECTION', href: `/collections/${collectionSlugs[0]}` };
  }
  if (scope === BundleScope.PRODUCTS && productSlugs.length === 1) {
    return { type: 'PRODUCT', href: `/products/${productSlugs[0]}` };
  }
  return { type: 'CATALOG', href: CATALOG_HREF };
}
