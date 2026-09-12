import { Injectable } from '@nestjs/common';
import { ResourceNotFoundException } from '../../common/exceptions/app.exception';
import { DEFAULT_LOCALE, Locale } from '../../common/i18n/localized-field';
import { PrismaService } from '../../prisma/prisma.service';
import { CART_INCLUDE, CartPricingService } from '../cart/cart-pricing.service';
import { computeShippingPrice, ShippingService } from '../shipping/shipping.service';
import { CheckoutQuoteDto } from './dto/checkout-quote.dto';

export interface CheckoutQuote {
  items: ReturnType<CartPricingService['buildView']>['items'];
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  total: number;
  currency: string;
  coupon: ReturnType<CartPricingService['buildView']>['coupon'];
  couponWarning?: string;
  issues: { itemId: string; reason: string }[];
}

/**
 * Read-only pricing preview: revalidates the cart's items/availability and
 * a chosen shipping rate against a destination country, but reserves
 * nothing and is not a permanent price guarantee - see
 * docs/BUSINESS_RULES.md. OrdersService.createOrder performs the exact
 * same computation again (from the live cart, not from anything cached
 * here) and compares it against the client-supplied `expectedTotal`
 * before committing anything.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: CartPricingService,
    private readonly shippingService: ShippingService,
  ) {}

  async quote(
    cartId: string,
    dto: CheckoutQuoteDto,
    locale: Locale = DEFAULT_LOCALE,
  ): Promise<CheckoutQuote> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: CART_INCLUDE,
    });
    if (!cart) {
      throw new ResourceNotFoundException('Cart', cartId);
    }

    const priced = this.pricingService.buildView(cart, locale);
    const shippingRate = await this.shippingService.resolveRateForCheckout(
      dto.shippingRateId,
      dto.country,
    );
    const shippingTotal = computeShippingPrice(shippingRate, priced.total);

    const issues = priced.items
      .filter((item) => !item.isAvailable)
      .map((item) => ({ itemId: item.id, reason: item.unavailableReason ?? 'unavailable' }));

    return {
      items: priced.items,
      subtotal: priced.subtotal,
      discountTotal: priced.discountTotal,
      shippingTotal,
      total: priced.total + shippingTotal,
      currency: priced.currency,
      coupon: priced.coupon,
      couponWarning: priced.couponWarning,
      issues,
    };
  }
}
