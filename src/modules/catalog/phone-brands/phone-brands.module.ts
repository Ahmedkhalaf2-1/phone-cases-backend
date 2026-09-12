import { Module } from '@nestjs/common';
import { PhoneBrandsAdminController } from './phone-brands-admin.controller';
import { PhoneBrandsPublicController } from './phone-brands-public.controller';
import { PhoneBrandsService } from './phone-brands.service';

@Module({
  controllers: [PhoneBrandsAdminController, PhoneBrandsPublicController],
  providers: [PhoneBrandsService],
  exports: [PhoneBrandsService],
})
export class PhoneBrandsModule {}
