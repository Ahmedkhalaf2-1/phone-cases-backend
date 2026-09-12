import { Module } from '@nestjs/common';
import { CouponsAdminController } from './coupons-admin.controller';
import { CouponsService } from './coupons.service';

@Module({
  controllers: [CouponsAdminController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
