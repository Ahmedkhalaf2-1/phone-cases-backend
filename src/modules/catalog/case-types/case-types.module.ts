import { Module } from '@nestjs/common';
import { CaseTypesAdminController } from './case-types-admin.controller';
import { CaseTypesPublicController } from './case-types-public.controller';
import { CaseTypesService } from './case-types.service';

@Module({
  controllers: [CaseTypesAdminController, CaseTypesPublicController],
  providers: [CaseTypesService],
  exports: [CaseTypesService],
})
export class CaseTypesModule {}
