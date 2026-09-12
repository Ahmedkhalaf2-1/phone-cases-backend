import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module';
import { StockItemsController } from './stock-items.controller';
import { StockItemsService } from './stock-items.service';

@Module({
  imports: [ReservationsModule],
  controllers: [StockItemsController],
  providers: [StockItemsService],
  exports: [StockItemsService],
})
export class StockItemsModule {}
