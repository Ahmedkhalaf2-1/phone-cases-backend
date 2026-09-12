import { Body, Controller, Post, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { DEFAULT_LOCALE, Locale } from '../../common/i18n/localized-field';
import { CartTokenGuard } from '../cart/cart-token.guard';
import { CurrentCartId } from '../cart/current-cart-id.decorator';
import { CheckoutService } from './checkout.service';
import { CheckoutQuoteDto } from './dto/checkout-quote.dto';

@ApiTags('checkout')
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post('quote')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  quote(
    @CurrentCartId() cartId: string,
    @Body() dto: CheckoutQuoteDto,
    @Query('locale') locale?: Locale,
  ) {
    return this.checkoutService.quote(cartId, dto, locale ?? DEFAULT_LOCALE);
  }
}
