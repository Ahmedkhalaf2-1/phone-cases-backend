import { Module } from '@nestjs/common';
import { PhoneModelsAdminController } from './phone-models-admin.controller';
import { PhoneModelsPublicController } from './phone-models-public.controller';
import { PhoneModelsService } from './phone-models.service';

@Module({
  controllers: [PhoneModelsAdminController, PhoneModelsPublicController],
  providers: [PhoneModelsService],
  exports: [PhoneModelsService],
})
export class PhoneModelsModule {}
