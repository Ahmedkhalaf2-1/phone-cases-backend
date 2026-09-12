import { Injectable } from '@nestjs/common';
import { CouponType, Prisma } from '@prisma/client';
import { DEFAULT_LOCALE, Locale, pickLocalized } from '../../common/i18n/localized-field';

export const CART_INCLUDE = {
  items: {
    include: {
      variant: {
        include: {
          product: true,
          phoneModel: { include: { brand: true } },
          caseType: true,
          stockItem: true,
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
  unitPrice: number;
  quantity: number;
  lineSubtotal: number;
  isAvailable: boolean;
  unavailableReason?: string;
}

export interface CartView {
  id: string;
  currency: string;
  items: CartItemView[];
  subtotal: number;
  discountTotal: number;
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
  buildView(cart: CartWithRelations, locale: Locale = DEFAULT_LOCALE): CartView {
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

    return {
      id: cart.id,
      currency: cart.currency,
      items,
      subtotal,
      discountTotal,
      total: subtotal - discountTotal,
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
    const hasStock =
      !variant.stockItem || variant.stockItem.onHand - variant.stockItem.reserved > 0;

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
      unitPrice: variant.price,
      quantity: item.quantity,
      lineSubtotal: variant.price * item.quantity,
      isAvailable: !unavailableReason,
      unavailableReason,
    };
  }
}
