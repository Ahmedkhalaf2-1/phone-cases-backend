import {
  BadRequestException,
  Body,
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
import { CartTokenGuard } from '../cart/cart-token.guard';
import { CurrentCartId } from '../cart/current-cart-id.decorator';
import { toCustomDesignView } from './custom-design-response.mapper';
import { CustomDesignsService } from './custom-designs.service';
import { UploadCustomDesignDto } from './dto/upload-custom-design.dto';

// Read directly from process.env (like MediaAdminController/
// ReceiptsCartController) since FileInterceptor's options are evaluated at
// decorator time, before Nest's DI/ConfigModule has run - this only bounds
// multer's own buffering; CustomDesignsService re-checks the authoritative,
// DI-driven limit from ConfigService.
const MAX_FILE_SIZE_BYTES = Number(
  process.env.CUSTOM_DESIGN_MAX_FILE_SIZE_BYTES ?? 10 * 1024 * 1024,
);

/**
 * Guest-facing, authenticated purely by the cart token - same pattern as
 * ReceiptsCartController. Image decoding/resizing is far more expensive
 * per request than a typical read, so this is rate-limited separately from
 * (and tighter than) the global default.
 */
@ApiTags('cart/custom-designs')
@Controller('cart/custom-designs')
export class CustomDesignsCartController {
  constructor(private readonly customDesignsService: CustomDesignsService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @ApiConsumes('multipart/form-data')
  @UseGuards(CartTokenGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_BYTES } }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadCustomDesignDto,
    @CurrentCartId() cartId: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file was uploaded under the "file" field');
    }
    const design = await this.customDesignsService.uploadForCart(cartId, dto.variantId, file);
    return toCustomDesignView(design);
  }

  @Get(':id')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentCartId() cartId: string) {
    const design = await this.customDesignsService.findOwnedOrThrow(cartId, id);
    return toCustomDesignView(design);
  }

  @Get(':id/original')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  async viewOriginal(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentCartId() cartId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mimeType } = await this.customDesignsService.getFileForCartOwner(
      cartId,
      id,
      'original',
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }

  @Get(':id/preview')
  @ApiHeader({ name: 'X-Cart-Token', required: true })
  @UseGuards(CartTokenGuard)
  async viewPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentCartId() cartId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mimeType } = await this.customDesignsService.getFileForCartOwner(
      cartId,
      id,
      'preview',
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }
}
