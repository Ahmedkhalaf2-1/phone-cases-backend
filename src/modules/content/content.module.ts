import { Module } from '@nestjs/common';
import { HomepageSectionsModule } from './homepage-sections/homepage-sections.module';
import { PagesModule } from './pages/pages.module';

@Module({
  imports: [HomepageSectionsModule, PagesModule],
})
export class ContentModule {}
