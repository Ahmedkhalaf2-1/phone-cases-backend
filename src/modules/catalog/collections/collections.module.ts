import { Module } from '@nestjs/common';
import { CollectionsAdminController } from './collections-admin.controller';
import { CollectionsPublicController } from './collections-public.controller';
import { CollectionsService } from './collections.service';

@Module({
  controllers: [CollectionsAdminController, CollectionsPublicController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
