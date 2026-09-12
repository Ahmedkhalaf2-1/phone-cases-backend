import { Module } from '@nestjs/common';
import { PagesAdminController } from './pages-admin.controller';
import { PagesPublicController } from './pages-public.controller';
import { PagesService } from './pages.service';

@Module({
  controllers: [PagesAdminController, PagesPublicController],
  providers: [PagesService],
  exports: [PagesService],
})
export class PagesModule {}
