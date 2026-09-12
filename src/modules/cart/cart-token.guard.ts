import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

export const CART_TOKEN_HEADER = 'x-cart-token';

/**
 * Grants access to a cart by its opaque `token`, never by the cart's
 * database id alone - see docs/DECISIONS.md. The token is expected in the
 * `X-Cart-Token` header rather than a path/query param so it doesn't end
 * up in server access logs or a shared/copied URL as readily.
 *
 * Deliberately does NOT reject a non-ACTIVE (e.g. already-ORDERED) cart -
 * only that the token resolves to a real cart at all. Rejecting here
 * would break idempotent order-creation retries: a client that retries
 * the exact same successful POST /orders request (same idempotency key)
 * must still reach OrdersService, which recognizes the key and returns
 * the original order, even though the cart is now ORDERED. Each mutating
 * cart operation (CartService.addItem etc.) checks for ACTIVE itself and
 * rejects with a clear, action-specific error instead.
 */
@Injectable()
export class CartTokenGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.headers[CART_TOKEN_HEADER];

    if (typeof token !== 'string' || token.length === 0) {
      throw new UnauthorizedException(`Missing ${CART_TOKEN_HEADER} header`);
    }

    const cart = await this.prisma.cart.findUnique({ where: { token } });
    if (!cart) {
      throw new UnauthorizedException('Cart token is invalid');
    }

    (request as Request & { cartId: string }).cartId = cart.id;
    return true;
  }
}
