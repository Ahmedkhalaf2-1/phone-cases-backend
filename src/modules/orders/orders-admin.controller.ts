import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentStaff } from '../../common/decorators/current-staff.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import type { AuthenticatedStaff } from '../auth/types/authenticated-staff.type';
import { AdminOrderQueryDto } from './dto/admin-order-query.dto';
import { UpdateFulfillmentStatusDto } from './dto/update-fulfillment-status.dto';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';
import { OrdersService } from './orders.service';

@ApiTags('admin/orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/orders')
export class OrdersAdminController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @Roles(StaffRole.OWNER_ADMIN, StaffRole.ORDER_OPERATOR)
  findAll(@Query() query: AdminOrderQueryDto) {
    return this.ordersService.findAllForAdmin(query);
  }

  @Get(':id')
  @Roles(StaffRole.OWNER_ADMIN, StaffRole.ORDER_OPERATOR)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.findByIdForAdmin(id);
  }

  @Patch(':id/fulfillment-status')
  @Roles(StaffRole.OWNER_ADMIN, StaffRole.ORDER_OPERATOR)
  updateFulfillmentStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFulfillmentStatusDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.ordersService.updateFulfillmentStatus(id, dto.status, actor);
  }

  // Financial action - restricted to OWNER_ADMIN only, per least-privilege
  // (see docs/BUSINESS_RULES.md roles table).
  @Patch(':id/payment-status')
  @Roles(StaffRole.OWNER_ADMIN)
  updatePaymentStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentStatusDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.ordersService.updatePaymentStatus(id, dto.status, actor);
  }
}
