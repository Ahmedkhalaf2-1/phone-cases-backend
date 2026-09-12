import { Module } from '@nestjs/common';
import { CartPricingService } from './cart-pricing.service';
import { CartTokenGuard } from './cart-token.guard';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
  controllers: [CartController],
  providers: [CartService, CartPricingService, CartTokenGuard],
  exports: [CartService, CartPricingService],
})
export class CartModule {}
