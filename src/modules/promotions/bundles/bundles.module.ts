import { Module } from '@nestjs/common';
import { BundlesAdminController } from './bundles-admin.controller';
import { BundlesService } from './bundles.service';

@Module({
  controllers: [BundlesAdminController],
  providers: [BundlesService],
  exports: [BundlesService],
})
export class BundlesModule {}
