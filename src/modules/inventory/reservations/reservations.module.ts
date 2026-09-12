import { Module } from '@nestjs/common';
import { ReservationsAdminController } from './reservations-admin.controller';
import { ReservationsService } from './reservations.service';

@Module({
  controllers: [ReservationsAdminController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
