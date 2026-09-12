import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { DEFAULT_LOCALE, Locale } from '../../common/i18n/localized-field';
import { CartService } from './cart.service';
import { CartTokenGuard } from './cart-token.guard';
import { CurrentCartId } from './current-cart-id.decorator';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { ApplyCouponDto } from './dto/apply-coupon.dto';
import { ReplaceCartItemVariantDto } from './dto/replace-cart-item-variant.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

@ApiTags('cart')
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Post()
  async create() {
    return this.cartService.createCart();
  }

  @Get()
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  getCart(@CurrentCartId() cartId: string, @Query('locale') locale?: Locale) {
    return this.cartService.getCart(cartId, locale ?? DEFAULT_LOCALE);
  }

  @Post('items')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  addItem(
    @CurrentCartId() cartId: string,
    @Body() dto: AddCartItemDto,
    @Query('locale') locale?: Locale,
  ) {
    return this.cartService.addItem(cartId, dto, locale ?? DEFAULT_LOCALE);
  }

  @Patch('items/:itemId')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  updateItem(
    @CurrentCartId() cartId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateCartItemDto,
    @Query('locale') locale?: Locale,
  ) {
    return this.cartService.updateItemQuantity(
      cartId,
      itemId,
      dto.quantity,
      locale ?? DEFAULT_LOCALE,
    );
  }

  @Patch('items/:itemId/variant')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  replaceItemVariant(
    @CurrentCartId() cartId: string,
    @Param('itemId') itemId: string,
    @Body() dto: ReplaceCartItemVariantDto,
    @Query('locale') locale?: Locale,
  ) {
    return this.cartService.replaceItemVariant(
      cartId,
      itemId,
      dto.newVariantId,
      locale ?? DEFAULT_LOCALE,
    );
  }

  @Delete('items/:itemId')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  removeItem(
    @CurrentCartId() cartId: string,
    @Param('itemId') itemId: string,
    @Query('locale') locale?: Locale,
  ) {
    return this.cartService.removeItem(cartId, itemId, locale ?? DEFAULT_LOCALE);
  }

  @Post('coupon')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  applyCoupon(
    @CurrentCartId() cartId: string,
    @Body() dto: ApplyCouponDto,
    @Query('locale') locale?: Locale,
  ) {
    return this.cartService.applyCoupon(cartId, dto.code, locale ?? DEFAULT_LOCALE);
  }

  @Delete('coupon')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  removeCoupon(@CurrentCartId() cartId: string, @Query('locale') locale?: Locale) {
    return this.cartService.removeCoupon(cartId, locale ?? DEFAULT_LOCALE);
  }
}
