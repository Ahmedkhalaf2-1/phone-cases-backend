import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaStorageDriver as MediaStorageDriverEnum } from '../../../config/env.validation';
import { CUSTOM_DESIGN_STORAGE } from './custom-design-storage.interface';
import { LocalCustomDesignStorageService } from './local-custom-design-storage.service';
import { UnavailableCustomDesignStorageService } from './unavailable-custom-design-storage.service';

@Module({
  providers: [
    LocalCustomDesignStorageService,
    UnavailableCustomDesignStorageService,
    {
      provide: CUSTOM_DESIGN_STORAGE,
      inject: [
        ConfigService,
        LocalCustomDesignStorageService,
        UnavailableCustomDesignStorageService,
      ],
      useFactory: (
        configService: ConfigService,
        local: LocalCustomDesignStorageService,
        unavailable: UnavailableCustomDesignStorageService,
      ) => {
        const driver = configService.getOrThrow<MediaStorageDriverEnum>('MEDIA_STORAGE_DRIVER');
        return driver === MediaStorageDriverEnum.S3 ? unavailable : local;
      },
    },
  ],
  exports: [CUSTOM_DESIGN_STORAGE],
})
export class CustomDesignStorageModule {}
