import { Module } from '@nestjs/common';
import { BundlesAdminController } from './bundles-admin.controller';
import { BundlesPublicController } from './bundles-public.controller';
import { BundlesService } from './bundles.service';

@Module({
  controllers: [BundlesAdminController, BundlesPublicController],
  providers: [BundlesService],
  exports: [BundlesService],
})
export class BundlesModule {}
