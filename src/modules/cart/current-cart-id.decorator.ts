import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

/** Reads the cart id attached to the request by CartTokenGuard. */
export const CurrentCartId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request & { cartId: string }>();
    return request.cartId;
  },
);
