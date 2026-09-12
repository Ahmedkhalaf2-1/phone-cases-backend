import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CartTokenGuard } from '../../cart/cart-token.guard';
import { CurrentCartId } from '../../cart/current-cart-id.decorator';
import { ReceiptsService } from './receipts.service';

// Read directly from process.env (like MediaAdminController) rather than
// ConfigService: FileInterceptor's options are evaluated at decorator time,
// before Nest's DI/ConfigModule has run. This bounds multer's own buffering
// so an oversized upload is rejected before the whole file is held in
// memory, not just after (ReceiptsService.decodeAndValidate re-checks the
// same limit from ConfigService for the authoritative, DI-driven value).
const MAX_FILE_SIZE_BYTES = Number(process.env.RECEIPT_MAX_FILE_SIZE_BYTES ?? 5 * 1024 * 1024);

/**
 * Guest-facing, authenticated purely by the cart token (never by
 * receiptId/orderNumber alone - see docs/BUSINESS_RULES.md). Multer keeps
 * the raw file bytes out of `request.body`, so LoggingInterceptor's
 * request-body redaction is never asked to handle image data at all -
 * see docs/DECISIONS.md for why nothing here needs its own log redaction.
 */
@ApiTags('cart/receipts')
@Controller('cart')
export class ReceiptsCartController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  // Rate-limited separately from (and far tighter than) the global default
  // (120/min, see app.module.ts) - an image-decoding upload is far more
  // expensive per request than a typical read, and this is an
  // unauthenticated (cart-token-only) endpoint.
  @Post('receipts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @ApiConsumes('multipart/form-data')
  @UseGuards(CartTokenGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_BYTES } }))
  async upload(@UploadedFile() file: Express.Multer.File, @CurrentCartId() cartId: string) {
    this.assertFilePresent(file);
    return this.receiptsService.uploadForCart(cartId, file);
  }

  // Post-rejection replacement: uploads and attaches to the cart's
  // existing order in one call - see ReceiptsService.uploadReplacementForCart
  // for exactly when this is allowed.
  @Post('receipts/replace')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @ApiConsumes('multipart/form-data')
  @UseGuards(CartTokenGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_BYTES } }))
  async replace(@UploadedFile() file: Express.Multer.File, @CurrentCartId() cartId: string) {
    this.assertFilePresent(file);
    return this.receiptsService.uploadReplacementForCart(cartId, file);
  }

  @Get('receipts/:receiptId/file')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  async viewOwnFile(
    @Param('receiptId', ParseUUIDPipe) receiptId: string,
    @CurrentCartId() cartId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mimeType } = await this.receiptsService.getFileForCartOwner(cartId, receiptId);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }

  private assertFilePresent(file: Express.Multer.File): void {
    if (!file) {
      // A plain Error here would fall through AllExceptionsFilter's
      // generic 500 branch - a missing upload field is a client mistake
      // (400), not a server fault. MediaAdminController has the same
      // pre-existing gap; left alone here since fixing it is outside this
      // module's scope.
      throw new BadRequestException('No file was uploaded under the "file" field');
    }
  }
}
