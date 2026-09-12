import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaStorageDriver as MediaStorageDriverEnum } from '../../../../config/env.validation';
import { LocalMediaStorageService } from './local-media-storage.service';
import { MEDIA_STORAGE } from './media-storage.interface';
import { UnavailableMediaStorageService } from './unavailable-media-storage.service';

@Module({
  providers: [
    LocalMediaStorageService,
    UnavailableMediaStorageService,
    {
      provide: MEDIA_STORAGE,
      inject: [ConfigService, LocalMediaStorageService, UnavailableMediaStorageService],
      useFactory: (
        configService: ConfigService,
        local: LocalMediaStorageService,
        unavailable: UnavailableMediaStorageService,
      ) => {
        const driver = configService.getOrThrow<MediaStorageDriverEnum>('MEDIA_STORAGE_DRIVER');
        return driver === MediaStorageDriverEnum.S3 ? unavailable : local;
      },
    },
  ],
  exports: [MEDIA_STORAGE],
})
export class MediaStorageModule {}
