import { Module } from '@nestjs/common';
import { VariantsAdminController } from './variants-admin.controller';
import { VariantsService } from './variants.service';

@Module({
  controllers: [VariantsAdminController],
  providers: [VariantsService],
  exports: [VariantsService],
})
export class VariantsModule {}
