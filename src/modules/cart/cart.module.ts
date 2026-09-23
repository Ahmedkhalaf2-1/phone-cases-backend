import { Module } from '@nestjs/common';
import { CustomDesignsModule } from '../custom-designs/custom-designs.module';
import { BundlesModule } from '../promotions/bundles/bundles.module';
import { CartPricingService } from './cart-pricing.service';
import { CartTokenGuard } from './cart-token.guard';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
  imports: [BundlesModule, CustomDesignsModule],
  controllers: [CartController],
  providers: [CartService, CartPricingService, CartTokenGuard],
  exports: [CartService, CartPricingService],
})
export class CartModule {}
