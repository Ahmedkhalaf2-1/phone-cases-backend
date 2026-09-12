import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentStaff } from '../../../common/decorators/current-staff.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreateOrderItemReturnDto } from './dto/create-order-item-return.dto';
import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundsService } from './refunds.service';

@ApiTags('admin/refunds')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/orders')
export class RefundsAdminController {
  constructor(private readonly service: RefundsService) {}

  // Financial action - restricted to OWNER_ADMIN only, same as
  // payment-status and receipt rejection (see docs/BUSINESS_RULES.md).
  @Post(':id/refunds')
  @Roles(StaffRole.OWNER_ADMIN)
  recordRefund(
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateRefundDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.service.recordRefund(orderId, dto, actor);
  }

  @Get(':id/refunds')
  @Roles(StaffRole.OWNER_ADMIN, StaffRole.ORDER_OPERATOR)
  findRefunds(@Param('id', ParseUUIDPipe) orderId: string) {
    return this.service.findRefundsForOrder(orderId);
  }

  @Post(':orderId/items/:itemId/returns')
  @Roles(StaffRole.OWNER_ADMIN, StaffRole.ORDER_OPERATOR)
  recordReturn(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: CreateOrderItemReturnDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.service.recordItemReturn(orderId, itemId, dto, actor);
  }

  @Get(':orderId/items/:itemId/returns')
  @Roles(StaffRole.OWNER_ADMIN, StaffRole.ORDER_OPERATOR)
  findReturns(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.findReturnsForOrderItem(orderId, itemId);
  }
}
