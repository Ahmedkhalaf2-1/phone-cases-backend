import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrderExpiryService } from './order-expiry.service';

/**
 * Order-aware manual trigger for the same sweep OrderExpiryScheduler runs
 * automatically every minute - releases expired stock reservations AND
 * cancels any order left dangling in PENDING/UNPAID as a result. Useful
 * right after restarting the app (to catch up immediately rather than
 * waiting for the next tick) or for an external cron/monitoring hook.
 */
@ApiTags('admin/orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.ORDER_OPERATOR)
@Controller('admin/orders')
export class OrderExpiryAdminController {
  constructor(private readonly orderExpiryService: OrderExpiryService) {}

  @Post('sweep-expired')
  @HttpCode(HttpStatus.OK)
  sweepExpired() {
    return this.orderExpiryService.sweepAndCancel();
  }
}
