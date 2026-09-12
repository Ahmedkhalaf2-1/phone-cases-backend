import { Module } from '@nestjs/common';
import { RefundsAdminController } from './refunds-admin.controller';
import { RefundsService } from './refunds.service';

@Module({
  controllers: [RefundsAdminController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
