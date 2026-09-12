import { Module } from '@nestjs/common';
import { HomepageSectionsAdminController } from './homepage-sections-admin.controller';
import { HomepageSectionsPublicController } from './homepage-sections-public.controller';
import { HomepageSectionsService } from './homepage-sections.service';

@Module({
  controllers: [HomepageSectionsAdminController, HomepageSectionsPublicController],
  providers: [HomepageSectionsService],
  exports: [HomepageSectionsService],
})
export class HomepageSectionsModule {}
