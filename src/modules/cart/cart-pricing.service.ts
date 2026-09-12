import { Injectable } from '@nestjs/common';
import { CouponType, Prisma } from '@prisma/client';
import { DEFAULT_LOCALE, Locale, pickLocalized } from '../../common/i18n/localized-field';
import {
  BundlePricingConfig,
  BundleSourceLine,
  computeBundleInstances,
} from '../promotions/bundles/bundle-pricing.util';

// Fetches only the ONE image that will actually be shown (primary first,
// then lowest displayOrder) directly at the DB level via `take: 1` -
// never the full media list just to pick one in application code. This
// is one nested query per relation (variant media, product media),
// batched by Prisma across all cart items in a single round trip each -
// not one query per item - so a cart with many lines stays O(1) queries,
// not O(n).
const PRIMARY_MEDIA_INCLUDE = {
  include: { mediaAsset: true },
  orderBy: [{ isPrimary: 'desc' as const }, { displayOrder: 'asc' as const }],
  take: 1,
};

export const CART_INCLUDE = {
  items: {
    include: {
      variant: {
        include: {
          product: { include: { media: PRIMARY_MEDIA_INCLUDE } },
          phoneModel: { include: { brand: true } },
          caseType: true,
          stockItem: true,
          media: PRIMARY_MEDIA_INCLUDE,
        },
      },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  coupon: true,
} satisfies Prisma.CartInclude;

export type CartWithRelations = Prisma.CartGetPayload<{ include: typeof CART_INCLUDE }>;
type CartItemWithRelations = CartWithRelations['items'][number];
type CartCoupon = NonNullable<CartWithRelations['coupon']>;

export interface CartItemView {
  id: string;
  variantId: string;
  sku: string;
  productSlug: string;
  productName: string;
  phoneModel: { slug: string; name: string; brand: string } | null;
  caseType: { slug: string; name: string } | null;
  thumbnail: { url: string; altText: string } | null;
  unitPrice: number;
  quantity: number;
  lineSubtotal: number;
  isAvailable: boolean;
  unavailableReason?: string;
  /** This line's share of any applied bundle discount(s) - see bundleDiscountTotal. */
  bundleDiscount: number;
}

export interface CartView {
  id: string;
  currency: string;
  items: CartItemView[];
  subtotal: number;
  discountTotal: number;
  /** Total savings from applied bundle promotions - see BundlesService. */
  bundleDiscountTotal: number;
  total: number;
  coupon: { code: string; type: CouponType; value: number } | null;
  couponWarning?: string;
}

/**
 * A coupon discount is always rounded DOWN to the nearest minor unit, in
 * the merchant's favor - see docs/BUSINESS_RULES.md. This keeps
 * `subtotal - discountTotal` exact with no fractional minor units to
 * allocate, which matters once refunds need to reverse a discount later.
 */
export function computeDiscount(
  coupon: Pick<CartCoupon, 'type' | 'value'>,
  subtotal: number,
): number {
  if (subtotal <= 0) return 0;
  const raw =
    coupon.type === CouponType.FIXED ? coupon.value : Math.floor((subtotal * coupon.value) / 100);
  return Math.min(raw, subtotal);
}

export function findCouponValidityError(
  coupon: Pick<
    CartCoupon,
    'isActive' | 'startsAt' | 'expiresAt' | 'minSpend' | 'usageLimit' | 'usageCount'
  >,
  subtotal: number,
  now: Date = new Date(),
): string | undefined {
  if (!coupon.isActive) return 'This coupon is no longer active';
  if (coupon.startsAt && coupon.startsAt > now) return 'This coupon is not active yet';
  if (coupon.expiresAt && coupon.expiresAt < now) return 'This coupon has expired';
  if (coupon.minSpend !== null && coupon.minSpend !== undefined && subtotal < coupon.minSpend) {
    return `This coupon requires a minimum spend of ${coupon.minSpend}`;
  }
  if (
    coupon.usageLimit !== null &&
    coupon.usageLimit !== undefined &&
    coupon.usageCount >= coupon.usageLimit
  ) {
    return 'This coupon has reached its usage limit';
  }
  return undefined;
}

@Injectable()
export class CartPricingService {
  /**
   * `activeBundles` is fetched by the caller (BundlesService) and passed
   * in rather than queried here, so this method stays a pure function of
   * its inputs - easy to unit test and guaranteed to compute bundle
   * discounts with the EXACT SAME logic (`computeBundleInstances`) here,
   * in CheckoutService's quote, and in OrdersService.createOrder. See
   * docs/BUSINESS_RULES.md.
   */
  buildView(
    cart: CartWithRelations,
    locale: Locale = DEFAULT_LOCALE,
    activeBundles: BundlePricingConfig[] = [],
  ): CartView {
    const items = cart.items.map((item) => this.toItemView(item, locale));
    const subtotal = items
      .filter((item) => item.isAvailable)
      .reduce((sum, item) => sum + item.lineSubtotal, 0);

    let discountTotal = 0;
    let couponWarning: string | undefined;
    if (cart.coupon) {
      const error = findCouponValidityError(cart.coupon, subtotal);
      if (error) {
        couponWarning = error;
      } else {
        discountTotal = computeDiscount(cart.coupon, subtotal);
      }
    }

    const couponIsApplied = Boolean(cart.coupon) && !couponWarning;
    const bundleSourceLines: BundleSourceLine[] = cart.items
      .map((item, lineIndex) => ({ item, lineIndex }))
      .filter(({ lineIndex }) => items[lineIndex].isAvailable)
      .map(({ item, lineIndex }) => ({
        lineIndex,
        variantId: item.variant.id,
        phoneModelId: item.variant.phoneModelId,
        unitPrice: item.variant.price,
        quantity: item.quantity,
        currency: item.variant.currency,
      }));
    const bundleInstances = computeBundleInstances(bundleSourceLines, activeBundles, {
      couponIsApplied,
    });

    const bundleDiscountByLine = new Map<number, number>();
    let bundleDiscountTotal = 0;
    for (const instance of bundleInstances) {
      bundleDiscountTotal += instance.discountAmount;
      for (const allocation of instance.unitAllocations) {
        bundleDiscountByLine.set(
          allocation.lineIndex,
          (bundleDiscountByLine.get(allocation.lineIndex) ?? 0) + allocation.discount,
        );
      }
    }
    items.forEach((item, index) => {
      item.bundleDiscount = bundleDiscountByLine.get(index) ?? 0;
    });

    return {
      id: cart.id,
      currency: cart.currency,
      items,
      subtotal,
      discountTotal,
      bundleDiscountTotal,
      total: subtotal - discountTotal - bundleDiscountTotal,
      coupon: cart.coupon
        ? { code: cart.coupon.code, type: cart.coupon.type, value: cart.coupon.value }
        : null,
      couponWarning,
    };
  }

  private toItemView(item: CartItemWithRelations, locale: Locale): CartItemView {
    const { variant } = item;
    const productPublished = variant.product.status === 'PUBLISHED';
    const variantActive = variant.isActive;
    // No StockItem linked: only available if explicitly opted into
    // unlimited stock (see docs/BUSINESS_RULES.md) - never assumed.
    const hasStock = variant.stockItem
      ? variant.stockItem.onHand - variant.stockItem.reserved > 0
      : variant.isUnlimitedStock;

    let unavailableReason: string | undefined;
    if (!productPublished || !variantActive) {
      unavailableReason = 'This item is no longer available';
    } else if (!hasStock) {
      unavailableReason = 'This item is currently out of stock';
    }

    return {
      id: item.id,
      variantId: variant.id,
      sku: variant.sku,
      productSlug: variant.product.slug,
      productName: pickLocalized(variant.product.nameEn, variant.product.nameAr, locale),
      phoneModel: variant.phoneModel
        ? {
            slug: variant.phoneModel.slug,
            name: pickLocalized(variant.phoneModel.nameEn, variant.phoneModel.nameAr, locale),
            brand: pickLocalized(
              variant.phoneModel.brand.nameEn,
              variant.phoneModel.brand.nameAr,
              locale,
            ),
          }
        : null,
      caseType: variant.caseType
        ? {
            slug: variant.caseType.slug,
            name: pickLocalized(variant.caseType.nameEn, variant.caseType.nameAr, locale),
          }
        : null,
      thumbnail: this.pickThumbnail(variant, locale),
      unitPrice: variant.price,
      quantity: item.quantity,
      lineSubtotal: variant.price * item.quantity,
      isAvailable: !unavailableReason,
      unavailableReason,
      bundleDiscount: 0,
    };
  }

  /**
   * A variant-specific image (e.g. this exact phone model + case combo)
   * wins if one was uploaded; otherwise falls back to the parent
   * product's own primary image, so a cart line is never thumbnail-less
   * just because nobody attached a photo to that specific variant. Never
   * a private receipt path - this only ever reads MediaAsset rows
   * attached through ProductMedia/VariantMedia, a completely separate
   * table from PaymentReceipt (see docs/BUSINESS_RULES.md §26).
   */
  private pickThumbnail(
    variant: CartItemWithRelations['variant'],
    locale: Locale,
  ): { url: string; altText: string } | null {
    const entry = variant.media[0] ?? variant.product.media[0];
    if (!entry) return null;
    return {
      url: entry.mediaAsset.url,
      altText: pickLocalized(entry.mediaAsset.altTextEn ?? '', entry.mediaAsset.altTextAr, locale),
    };
  }
}
