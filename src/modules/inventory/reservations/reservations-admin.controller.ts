import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ReservationsService } from './reservations.service';

/**
 * Manual, inventory-only trigger for releasing expired stock reservations.
 * This only touches StockItem/StockReservation counters - it does not
 * know about orders, so an order whose reservation expires here is left
 * with a dangling ACTIVE-looking status until something else notices.
 *
 * The order-aware sweep that also cancels affected orders lives in
 * OrdersModule (`POST /admin/orders/sweep-expired`) and is what the
 * scheduled background job (OrderExpiryScheduler) actually calls. This
 * endpoint remains for inventory-only diagnostics/manual use.
 */
@ApiTags('admin/stock-reservations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/stock-reservations')
export class ReservationsAdminController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post('sweep-expired')
  @HttpCode(HttpStatus.OK)
  async sweepExpired(): Promise<{ released: number }> {
    const released = await this.reservationsService.releaseAllExpired();
    return { released: released.length };
  }
}
