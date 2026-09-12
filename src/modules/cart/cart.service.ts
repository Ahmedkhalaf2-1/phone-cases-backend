import { randomBytes } from 'node:crypto';
import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { CartStatus, ProductStatus, StockItem } from '@prisma/client';
import { AppException, ResourceNotFoundException } from '../../common/exceptions/app.exception';
import { Locale } from '../../common/i18n/localized-field';
import { PrismaService } from '../../prisma/prisma.service';
import { BundlesService } from '../promotions/bundles/bundles.service';
import { AddCartItemDto, MAX_CART_ITEM_QUANTITY } from './dto/add-cart-item.dto';
import {
  CART_INCLUDE,
  CartPricingService,
  CartView,
  CartWithRelations,
  findCouponValidityError,
} from './cart-pricing.service';

const CART_TOKEN_BYTES = 32;

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: CartPricingService,
    private readonly bundlesService: BundlesService,
  ) {}

  async createCart(): Promise<{ token: string; cart: CartView }> {
    const token = randomBytes(CART_TOKEN_BYTES).toString('base64url');
    const cart = await this.prisma.cart.create({ data: { token }, include: CART_INCLUDE });
    // A freshly created cart has no items yet, so there is nothing to
    // bundle - no need to fetch active bundles just to pass an empty cart.
    return { token, cart: this.pricingService.buildView(cart) };
  }

  async getCart(cartId: string, locale?: Locale): Promise<CartView> {
    const cart = await this.loadCartOrThrow(cartId);
    const activeBundles = await this.bundlesService.findActiveForPricing();
    return this.pricingService.buildView(cart, locale, activeBundles);
  }

  /**
   * Adding to a cart deliberately does not reserve stock (see
   * docs/BUSINESS_RULES.md) - the availability check here is informative
   * only, using the live onHand/reserved counters at the moment of the
   * request. It can still say yes now and be wrong by the time checkout
   * (Phase 3) actually reserves stock; that revalidation is mandatory and
   * happens there, not here.
   */
  async addItem(cartId: string, dto: AddCartItemDto, locale?: Locale): Promise<CartView> {
    await this.assertCartIsActive(cartId);
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: dto.variantId },
      include: { product: true, stockItem: true },
    });
    if (!variant) {
      throw new ResourceNotFoundException('ProductVariant', dto.variantId);
    }
    if (!variant.isActive || variant.product.status !== ProductStatus.PUBLISHED) {
      throw new AppException(
        'VARIANT_NOT_PURCHASABLE',
        'This variant is not currently purchasable',
        HttpStatus.CONFLICT,
      );
    }

    const existing = await this.prisma.cartItem.findUnique({
      where: { cartId_variantId: { cartId, variantId: dto.variantId } },
    });
    const newQuantity = (existing?.quantity ?? 0) + dto.quantity;
    if (newQuantity > MAX_CART_ITEM_QUANTITY) {
      throw new BadRequestException(
        `Quantity for a single item cannot exceed ${MAX_CART_ITEM_QUANTITY}`,
      );
    }
    await this.assertSoftAvailability(
      cartId,
      variant.stockItem,
      variant.isUnlimitedStock,
      newQuantity,
      existing ? [existing.id] : [],
    );

    await this.prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId, variantId: dto.variantId } },
      create: { cartId, variantId: dto.variantId, quantity: dto.quantity },
      update: { quantity: newQuantity },
    });

    return this.getCart(cartId, locale);
  }

  async updateItemQuantity(
    cartId: string,
    itemId: string,
    quantity: number,
    locale?: Locale,
  ): Promise<CartView> {
    await this.assertCartIsActive(cartId);
    const item = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cartId },
      include: { variant: { include: { stockItem: true } } },
    });
    if (!item) {
      throw new ResourceNotFoundException('CartItem', itemId);
    }

    if (quantity === 0) {
      await this.prisma.cartItem.delete({ where: { id: itemId } });
    } else {
      await this.assertSoftAvailability(
        cartId,
        item.variant.stockItem,
        item.variant.isUnlimitedStock,
        quantity,
        [itemId],
      );
      await this.prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
    }

    return this.getCart(cartId, locale);
  }

  /**
   * Atomically switches one cart line to a different variant (e.g. the
   * customer picks a different phone model for the same design) without
   * a separate remove+add round trip. Every check (new variant exists,
   * is purchasable, resulting quantity is available) happens before any
   * write, and the actual mutation runs in one DB transaction - so if
   * validation or the transaction fails for any reason, the original
   * item is left completely untouched, never removed-then-failed-to-add.
   *
   * If the cart already has a separate line for `newVariantId`, the two
   * lines are merged (quantities summed, capped at
   * MAX_CART_ITEM_QUANTITY) into that existing line and the original line
   * is removed, mirroring how `addItem` merges duplicates.
   */
  async replaceItemVariant(
    cartId: string,
    itemId: string,
    newVariantId: string,
    locale?: Locale,
  ): Promise<CartView> {
    await this.assertCartIsActive(cartId);
    const originalItem = await this.prisma.cartItem.findFirst({ where: { id: itemId, cartId } });
    if (!originalItem) {
      throw new ResourceNotFoundException('CartItem', itemId);
    }

    if (originalItem.variantId === newVariantId) {
      return this.getCart(cartId, locale);
    }

    const newVariant = await this.prisma.productVariant.findUnique({
      where: { id: newVariantId },
      include: { product: true, stockItem: true },
    });
    if (!newVariant) {
      throw new ResourceNotFoundException('ProductVariant', newVariantId);
    }
    if (!newVariant.isActive || newVariant.product.status !== ProductStatus.PUBLISHED) {
      throw new AppException(
        'VARIANT_NOT_PURCHASABLE',
        'The requested variant is not currently purchasable',
        HttpStatus.CONFLICT,
      );
    }

    const existingTargetItem = await this.prisma.cartItem.findUnique({
      where: { cartId_variantId: { cartId, variantId: newVariantId } },
    });
    const resultingQuantity = Math.min(
      (existingTargetItem?.quantity ?? 0) + originalItem.quantity,
      MAX_CART_ITEM_QUANTITY,
    );
    const excludeItemIds = existingTargetItem
      ? [originalItem.id, existingTargetItem.id]
      : [originalItem.id];
    await this.assertSoftAvailability(
      cartId,
      newVariant.stockItem,
      newVariant.isUnlimitedStock,
      resultingQuantity,
      excludeItemIds,
    );

    await this.prisma.$transaction(async (tx) => {
      if (existingTargetItem) {
        await tx.cartItem.update({
          where: { id: existingTargetItem.id },
          data: { quantity: resultingQuantity },
        });
        await tx.cartItem.delete({ where: { id: originalItem.id } });
      } else {
        await tx.cartItem.update({
          where: { id: originalItem.id },
          data: { variantId: newVariantId, quantity: resultingQuantity },
        });
      }
    });

    return this.getCart(cartId, locale);
  }

  async removeItem(cartId: string, itemId: string, locale?: Locale): Promise<CartView> {
    await this.assertCartIsActive(cartId);
    const item = await this.prisma.cartItem.findFirst({ where: { id: itemId, cartId } });
    if (!item) {
      throw new ResourceNotFoundException('CartItem', itemId);
    }
    await this.prisma.cartItem.delete({ where: { id: itemId } });
    return this.getCart(cartId, locale);
  }

  async applyCoupon(cartId: string, rawCode: string, locale?: Locale): Promise<CartView> {
    const cart = await this.loadCartOrThrow(cartId);
    this.assertCartStatusIsActive(cart.status);

    const code = rawCode.trim().toUpperCase();
    const coupon = await this.prisma.coupon.findUnique({ where: { code } });
    if (!coupon) {
      throw new ResourceNotFoundException('Coupon', code);
    }

    const currentView = this.pricingService.buildView(cart);
    const error = findCouponValidityError(coupon, currentView.subtotal);
    if (error) {
      throw new AppException('COUPON_NOT_APPLICABLE', error, HttpStatus.BAD_REQUEST);
    }

    await this.prisma.cart.update({ where: { id: cartId }, data: { couponId: coupon.id } });
    return this.getCart(cartId, locale);
  }

  async removeCoupon(cartId: string, locale?: Locale): Promise<CartView> {
    await this.assertCartIsActive(cartId);
    await this.prisma.cart.update({ where: { id: cartId }, data: { couponId: null } });
    return this.getCart(cartId, locale);
  }

  private async loadCartOrThrow(cartId: string): Promise<CartWithRelations> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: CART_INCLUDE,
    });
    if (!cart) {
      throw new ResourceNotFoundException('Cart', cartId);
    }
    return cart;
  }

  /**
   * CartTokenGuard deliberately allows a non-ACTIVE cart through (needed
   * for idempotent order-creation retries - see its own docstring), so
   * every cart *mutation* checks ACTIVE for itself. Read-only `getCart`
   * intentionally does not call this - viewing an already-ordered cart
   * (e.g. right after checkout) is harmless.
   */
  private async assertCartIsActive(cartId: string): Promise<void> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      select: { status: true },
    });
    if (!cart) {
      throw new ResourceNotFoundException('Cart', cartId);
    }
    this.assertCartStatusIsActive(cart.status);
  }

  private assertCartStatusIsActive(status: CartStatus): void {
    if (status !== CartStatus.ACTIVE) {
      throw new AppException(
        'CART_NOT_ACTIVE',
        'This cart is no longer active (it may already have been converted to an order) and can no longer be modified',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * A variant with no linked StockItem is only purchasable if a staff
   * member explicitly opted it into unlimited stock (`isUnlimitedStock`)
   * - never assumed by default (see docs/BUSINESS_RULES.md). This must
   * stay consistent with the same rule in CartPricingService/
   * product-response.mapper.ts, since a variant flagged unavailable there
   * must not remain addable to the cart here.
   *
   * Multiple cart lines (different variants - e.g. different print-on-
   * demand designs) can share the same StockItem, so this must consider
   * their COMBINED demand, not just the one line being added/updated in
   * isolation - otherwise two lines each individually "within stock"
   * could together exceed it, matching the aggregation
   * OrdersService.createOrder actually enforces atomically at checkout
   * (see docs/DATA_MODEL.md §4). `excludeItemIds` leaves out cart rows
   * whose quantity is already folded into `requestedQuantity` by the
   * caller (the line being updated, or a line being merged away).
   */
  private async assertSoftAvailability(
    cartId: string,
    stockItem: StockItem | null,
    isUnlimitedStock: boolean,
    requestedQuantity: number,
    excludeItemIds: string[] = [],
  ): Promise<void> {
    if (!stockItem) {
      if (!isUnlimitedStock) {
        throw new AppException(
          'INSUFFICIENT_STOCK',
          'This item is not currently available for purchase',
          HttpStatus.CONFLICT,
        );
      }
      return;
    }

    const otherLines = await this.prisma.cartItem.findMany({
      where: {
        cartId,
        variant: { stockItemId: stockItem.id },
        ...(excludeItemIds.length > 0 ? { id: { notIn: excludeItemIds } } : {}),
      },
      select: { quantity: true },
    });
    const otherQuantity = otherLines.reduce((sum, line) => sum + line.quantity, 0);

    const available = stockItem.onHand - stockItem.reserved;
    if (requestedQuantity + otherQuantity > available) {
      throw new AppException(
        'INSUFFICIENT_STOCK',
        `Only ${Math.max(available - otherQuantity, 0)} unit(s) currently available for this item`,
        HttpStatus.CONFLICT,
      );
    }
  }
}
