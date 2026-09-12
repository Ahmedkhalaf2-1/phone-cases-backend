import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DEFAULT_LOCALE, Locale } from '../../common/i18n/localized-field';
import { PaymentMethod } from '../../config/env.validation';
import { CartTokenGuard } from '../cart/cart-token.guard';
import { CurrentCartId } from '../cart/current-cart-id.decorator';
import { CreateOrderDto } from './dto/create-order.dto';
import { toGuestOrderView } from './order-response.mapper';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@Controller('orders')
export class OrdersPublicController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly configService: ConfigService,
  ) {}

  // Order creation opens a multi-write transaction (coupon check, order +
  // snapshot rows, stock reservation, cart update, audit log) - far more
  // expensive than a typical request, so it gets a tighter per-IP limit
  // than the global default (120/min, see app.module.ts) rather than
  // relying only on that.
  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  async create(
    @CurrentCartId() cartId: string,
    @Body() dto: CreateOrderDto,
    @Query('locale') locale?: Locale,
  ) {
    // No payment provider is confirmed/integrated yet (see
    // docs/DECISIONS.md "Payment scope") - public order acceptance stays
    // explicitly unavailable rather than silently accepting orders nobody
    // can pay for. OrdersService.createOrder itself is fully implemented
    // and tested regardless (see test/orders.e2e-spec.ts), so this gate
    // only affects the public HTTP path, not the ability to develop
    // against or verify the order pipeline.
    const paymentMethod = this.configService.getOrThrow<PaymentMethod>('PAYMENT_METHOD');
    if (paymentMethod === PaymentMethod.None) {
      throw new ServiceUnavailableException(
        'Ordering is not yet available - no payment method has been configured for this store.',
      );
    }

    const order = await this.ordersService.createOrder(cartId, dto);
    return toGuestOrderView(order, locale ?? DEFAULT_LOCALE);
  }

  @Get('track/:trackingToken')
  async track(@Param('trackingToken') trackingToken: string, @Query('locale') locale?: Locale) {
    const order = await this.ordersService.findByTrackingToken(trackingToken);
    return toGuestOrderView(order, locale ?? DEFAULT_LOCALE);
  }
}
