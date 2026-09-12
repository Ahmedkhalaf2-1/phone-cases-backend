import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaStorageDriver as MediaStorageDriverEnum } from '../../../../config/env.validation';
import { LocalReceiptStorageService } from './local-receipt-storage.service';
import { RECEIPT_STORAGE } from './receipt-storage.interface';
import { UnavailableReceiptStorageService } from './unavailable-receipt-storage.service';

@Module({
  providers: [
    LocalReceiptStorageService,
    UnavailableReceiptStorageService,
    {
      provide: RECEIPT_STORAGE,
      inject: [ConfigService, LocalReceiptStorageService, UnavailableReceiptStorageService],
      useFactory: (
        configService: ConfigService,
        local: LocalReceiptStorageService,
        unavailable: UnavailableReceiptStorageService,
      ) => {
        const driver = configService.getOrThrow<MediaStorageDriverEnum>('MEDIA_STORAGE_DRIVER');
        return driver === MediaStorageDriverEnum.S3 ? unavailable : local;
      },
    },
  ],
  exports: [RECEIPT_STORAGE],
})
export class ReceiptStorageModule {}
