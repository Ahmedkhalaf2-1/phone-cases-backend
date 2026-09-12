import { Module } from '@nestjs/common';
import { MediaAdminController } from './media-admin.controller';
import { MediaService } from './media.service';
import { MediaStorageModule } from './storage/media-storage.module';

@Module({
  imports: [MediaStorageModule],
  controllers: [MediaAdminController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
