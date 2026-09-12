import { Controller, Get, Param, ParseUUIDPipe, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import type { Response } from 'express';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ReceiptsService } from './receipts.service';

/**
 * Staff view of a receipt's image bytes - gated by role only (any staff
 * member allowed to view orders can view their receipts), never by an
 * order number or receipt id alone. See docs/BUSINESS_RULES.md.
 */
@ApiTags('admin/receipts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.ORDER_OPERATOR)
@Controller('admin/receipts')
export class ReceiptsAdminController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Get(':receiptId/file')
  async viewFile(
    @Param('receiptId', ParseUUIDPipe) receiptId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mimeType } = await this.receiptsService.getFileForStaff(receiptId);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }
}
