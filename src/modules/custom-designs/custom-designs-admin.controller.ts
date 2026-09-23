import { Controller, Get, Param, ParseUUIDPipe, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import type { Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CustomDesignFileKind, CustomDesignsService } from './custom-designs.service';

/**
 * Staff download of a personalized order line's files - gated by role
 * only, never by ownership (same pattern as ReceiptsAdminController), and
 * keyed by `orderItemId` (never a CustomDesign id) so admin access is
 * always scoped to what was actually ordered, not whatever a cart's design
 * currently looks like. This is the ONLY way an admin gets the print-ready
 * file - never by extracting artwork from the mockup preview.
 */
@ApiTags('admin/custom-designs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.ORDER_OPERATOR)
@Controller('admin/order-items')
export class CustomDesignsAdminController {
  constructor(private readonly customDesignsService: CustomDesignsService) {}

  @Get(':orderItemId/custom-design/original')
  async downloadOriginal(
    @Param('orderItemId', ParseUUIDPipe) orderItemId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.sendFile(orderItemId, 'original', res);
  }

  @Get(':orderItemId/custom-design/print-file')
  async downloadPrintFile(
    @Param('orderItemId', ParseUUIDPipe) orderItemId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.sendFile(orderItemId, 'print', res);
  }

  @Get(':orderItemId/custom-design/preview')
  async downloadPreview(
    @Param('orderItemId', ParseUUIDPipe) orderItemId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.sendFile(orderItemId, 'preview', res);
  }

  private async sendFile(
    orderItemId: string,
    kind: CustomDesignFileKind,
    res: Response,
  ): Promise<void> {
    const { buffer, mimeType } = await this.customDesignsService.getOrderItemFileForAdmin(
      orderItemId,
      kind,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    if (kind === 'print') {
      // The file production actually uses - flagged as an attachment/
      // download rather than an inline preview.
      res.setHeader('Content-Disposition', `attachment; filename="print-${orderItemId}"`);
    }
    res.send(buffer);
  }
}
