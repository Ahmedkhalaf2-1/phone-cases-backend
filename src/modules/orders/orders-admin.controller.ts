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
import { ReceiptsService } from '../payments/receipts/receipts.service';
import { RejectReceiptDto } from '../payments/receipts/dto/reject-receipt.dto';
import { AdminOrderQueryDto } from './dto/admin-order-query.dto';
import { FlagLatePaymentDto } from './dto/flag-late-payment.dto';
import { UpdateFulfillmentStatusDto } from './dto/update-fulfillment-status.dto';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';
import { OrdersService } from './orders.service';

@ApiTags('admin/orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/orders')
export class OrdersAdminController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly receiptsService: ReceiptsService,
  ) {}

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
  // (see docs/BUSINESS_RULES.md roles table). Reused as-is for InstaPay:
  // marking PAID here is the one and only way an order's payment is ever
  // confirmed - uploading a screenshot never does this by itself.
  @Patch(':id/payment-status')
  @Roles(StaffRole.OWNER_ADMIN)
  updatePaymentStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentStatusDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.ordersService.updatePaymentStatus(id, dto.status, actor);
  }

  // A judgment call about whether funds were actually received - treated
  // as financial, same restriction as payment-status.
  @Patch(':id/receipts/:receiptId/reject')
  @Roles(StaffRole.OWNER_ADMIN)
  rejectReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('receiptId', ParseUUIDPipe) receiptId: string,
    @Body() dto: RejectReceiptDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.receiptsService.rejectReceipt(id, receiptId, dto.reason, actor);
  }

  // See OrdersService.flagLatePayment - audited note only, never restores
  // fulfillment or payment status.
  @Patch(':id/flag-late-payment')
  @Roles(StaffRole.OWNER_ADMIN)
  flagLatePayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FlagLatePaymentDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.ordersService.flagLatePayment(id, dto.note, actor);
  }
}
