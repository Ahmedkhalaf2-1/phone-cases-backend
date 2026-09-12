import { DEFAULT_LOCALE, Locale, pickLocalized } from '../../../common/i18n/localized-field';
import type { AdminProductWithRelations } from './products.service';

function isVariantAvailable(variant: AdminProductWithRelations['variants'][number]): boolean {
  if (!variant.isActive) return false;
  if (!variant.stockItem) {
    // No StockItem linked: available only if a staff member explicitly
    // opted this variant into unlimited stock - never assumed by default.
    // See docs/BUSINESS_RULES.md and docs/DATA_MODEL.md §4.
    return variant.isUnlimitedStock;
  }
  return variant.stockItem.onHand - variant.stockItem.reserved > 0;
}

/**
 * A variant-specific image wins if one was uploaded; otherwise falls back
 * to the parent product's own primary image, so a variant is never
 * thumbnail-less just because nobody attached a photo to that specific
 * phone model/case combo. Mirrors CartPricingService's pickThumbnail -
 * both read the same take:1/isPrimary-then-displayOrder media includes.
 */
function pickVariantThumbnail(
  variant: AdminProductWithRelations['variants'][number],
  product: AdminProductWithRelations,
  locale: Locale,
): { url: string; altText: string } | null {
  const entry = variant.media[0] ?? product.media[0];
  if (!entry) return null;
  return {
    url: entry.mediaAsset.url,
    altText: pickLocalized(entry.mediaAsset.altTextEn ?? '', entry.mediaAsset.altTextAr, locale),
  };
}

function toPublicVariant(
  variant: AdminProductWithRelations['variants'][number],
  product: AdminProductWithRelations,
  locale: Locale,
) {
  return {
    id: variant.id,
    sku: variant.sku,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    currency: variant.currency,
    isAvailable: isVariantAvailable(variant),
    thumbnail: pickVariantThumbnail(variant, product, locale),
    phoneModel: variant.phoneModel
      ? {
          id: variant.phoneModel.id,
          slug: variant.phoneModel.slug,
          name: pickLocalized(variant.phoneModel.nameEn, variant.phoneModel.nameAr, locale),
          brand: {
            id: variant.phoneModel.brand.id,
            slug: variant.phoneModel.brand.slug,
            name: pickLocalized(
              variant.phoneModel.brand.nameEn,
              variant.phoneModel.brand.nameAr,
              locale,
            ),
          },
        }
      : null,
    caseType: variant.caseType
      ? {
          id: variant.caseType.id,
          slug: variant.caseType.slug,
          name: pickLocalized(variant.caseType.nameEn, variant.caseType.nameAr, locale),
        }
      : null,
  };
}

function toPublicMedia(media: AdminProductWithRelations['media']) {
  return media
    .filter((entry) => entry.mediaAsset)
    .map((entry) => ({
      id: entry.mediaAsset.id,
      url: entry.mediaAsset.url,
      altText: pickLocalized(
        entry.mediaAsset.altTextEn ?? '',
        entry.mediaAsset.altTextAr,
        DEFAULT_LOCALE,
      ),
      isPrimary: entry.isPrimary,
      displayOrder: entry.displayOrder,
    }));
}

export function toPublicProductSummary(product: AdminProductWithRelations, locale: Locale) {
  const availableVariants = product.variants.filter((variant) => variant.isActive);
  const prices = availableVariants.map((variant) => variant.price);
  const minPrice = prices.length > 0 ? Math.min(...prices) : null;
  const primaryMedia = product.media.find((m) => m.isPrimary) ?? product.media[0];

  return {
    id: product.id,
    slug: product.slug,
    name: pickLocalized(product.nameEn, product.nameAr, locale),
    description: product.descriptionEn
      ? pickLocalized(product.descriptionEn, product.descriptionAr, locale)
      : null,
    currency: availableVariants[0]?.currency ?? product.currency,
    effectivePriceFrom: minPrice,
    isAvailable: availableVariants.some((variant) => isVariantAvailable(variant)),
    primaryImage: primaryMedia
      ? {
          url: primaryMedia.mediaAsset.url,
          altText: pickLocalized(
            primaryMedia.mediaAsset.altTextEn ?? '',
            primaryMedia.mediaAsset.altTextAr,
            locale,
          ),
        }
      : null,
    collections: product.collections.map((entry) => ({
      id: entry.collection.id,
      slug: entry.collection.slug,
      name: pickLocalized(entry.collection.nameEn, entry.collection.nameAr, locale),
    })),
  };
}

export function toPublicProductDetail(product: AdminProductWithRelations, locale: Locale) {
  return {
    ...toPublicProductSummary(product, locale),
    media: toPublicMedia(product.media),
    variants: product.variants.map((variant) => toPublicVariant(variant, product, locale)),
  };
}
