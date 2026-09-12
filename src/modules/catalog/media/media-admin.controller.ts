import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentStaff } from '../../../common/decorators/current-staff.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { AttachMediaDto } from './dto/attach-media.dto';
import { UploadMediaDto } from './dto/upload-media.dto';
import { MediaService } from './media.service';

const MAX_FILE_SIZE_BYTES = Number(process.env.MEDIA_MAX_FILE_SIZE_BYTES ?? 5 * 1024 * 1024);

@ApiTags('admin/media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/media')
export class MediaAdminController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_BYTES } }))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadMediaDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    if (!file) {
      throw new Error('No file was uploaded under the "file" field');
    }
    return this.mediaService.upload(file, dto, actor);
  }

  @Get()
  findAll() {
    return this.mediaService.findAll();
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id', ParseUUIDPipe) id: string, @CurrentStaff() actor: AuthenticatedStaff) {
    return this.mediaService.delete(id, actor);
  }

  @Post('products/:productId')
  attachToProduct(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: AttachMediaDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.mediaService.attachToProduct(productId, dto, actor);
  }

  @Delete('products/:productId/:mediaAssetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  detachFromProduct(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('mediaAssetId', ParseUUIDPipe) mediaAssetId: string,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.mediaService.detachFromProduct(productId, mediaAssetId, actor);
  }

  @Post('variants/:variantId')
  attachToVariant(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: AttachMediaDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.mediaService.attachToVariant(variantId, dto, actor);
  }

  @Delete('variants/:variantId/:mediaAssetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  detachFromVariant(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('mediaAssetId', ParseUUIDPipe) mediaAssetId: string,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.mediaService.detachFromVariant(variantId, mediaAssetId, actor);
  }
}
