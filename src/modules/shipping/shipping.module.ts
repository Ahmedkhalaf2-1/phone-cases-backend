import { Module } from '@nestjs/common';
import { ShippingAdminController } from './shipping-admin.controller';
import { ShippingPublicController } from './shipping-public.controller';
import { ShippingService } from './shipping.service';

@Module({
  controllers: [ShippingAdminController, ShippingPublicController],
  providers: [ShippingService],
  exports: [ShippingService],
})
export class ShippingModule {}
