import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { MediaAsset, Prisma } from '@prisma/client';
import sharp from 'sharp';
import { ResourceNotFoundException } from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { AttachMediaDto } from './dto/attach-media.dto';
import { UploadMediaDto } from './dto/upload-media.dto';
import { MEDIA_STORAGE, MediaStorageDriver } from './storage/media-storage.interface';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorageDriver,
  ) {}

  async upload(
    file: Express.Multer.File,
    dto: UploadMediaDto,
    actor: AuthenticatedStaff,
  ): Promise<MediaAsset> {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed types: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      );
    }

    let width: number | undefined;
    let height: number | undefined;
    try {
      const metadata = await sharp(file.buffer).metadata();
      width = metadata.width;
      height = metadata.height;
    } catch {
      throw new BadRequestException(
        'The uploaded file could not be decoded as a valid image - it may be corrupt or mislabeled',
      );
    }

    const saved = await this.storage.save(file.buffer, file.originalname, file.mimetype);

    const mediaAsset = await this.prisma.mediaAsset.create({
      data: {
        storageKey: saved.storageKey,
        url: saved.url,
        mimeType: file.mimetype,
        fileSizeBytes: file.size,
        width,
        height,
        altTextEn: dto.altTextEn,
        altTextAr: dto.altTextAr,
        uploadedByStaffId: actor.id,
      },
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'media.upload',
      entityType: 'MediaAsset',
      entityId: mediaAsset.id,
      metadata: { mimeType: file.mimetype, fileSizeBytes: file.size },
    });

    return mediaAsset;
  }

  async findAll(): Promise<MediaAsset[]> {
    return this.prisma.mediaAsset.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async delete(id: string, actor: AuthenticatedStaff): Promise<void> {
    const mediaAsset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!mediaAsset) {
      throw new ResourceNotFoundException('MediaAsset', id);
    }

    try {
      await this.prisma.mediaAsset.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException(
          'This media asset is still attached to a product or variant. Detach it first.',
        );
      }
      throw error;
    }

    await this.storage.delete(mediaAsset.storageKey);
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'media.delete',
      entityType: 'MediaAsset',
      entityId: id,
    });
  }

  async attachToProduct(
    productId: string,
    dto: AttachMediaDto,
    actor: AuthenticatedStaff,
  ): Promise<void> {
    await this.assertProductExists(productId);
    await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.productMedia.updateMany({ where: { productId }, data: { isPrimary: false } });
      }
      await tx.productMedia.create({
        data: {
          productId,
          mediaAssetId: dto.mediaAssetId,
          displayOrder: dto.displayOrder ?? 0,
          isPrimary: dto.isPrimary ?? false,
        },
      });
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'product.media.attach',
      entityType: 'Product',
      entityId: productId,
      metadata: { mediaAssetId: dto.mediaAssetId },
    });
  }

  async detachFromProduct(
    productId: string,
    mediaAssetId: string,
    actor: AuthenticatedStaff,
  ): Promise<void> {
    await this.prisma.productMedia.deleteMany({ where: { productId, mediaAssetId } });
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'product.media.detach',
      entityType: 'Product',
      entityId: productId,
      metadata: { mediaAssetId },
    });
  }

  async attachToVariant(
    variantId: string,
    dto: AttachMediaDto,
    actor: AuthenticatedStaff,
  ): Promise<void> {
    await this.assertVariantExists(variantId);
    await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.variantMedia.updateMany({ where: { variantId }, data: { isPrimary: false } });
      }
      await tx.variantMedia.create({
        data: {
          variantId,
          mediaAssetId: dto.mediaAssetId,
          displayOrder: dto.displayOrder ?? 0,
          isPrimary: dto.isPrimary ?? false,
        },
      });
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'variant.media.attach',
      entityType: 'ProductVariant',
      entityId: variantId,
      metadata: { mediaAssetId: dto.mediaAssetId },
    });
  }

  async detachFromVariant(
    variantId: string,
    mediaAssetId: string,
    actor: AuthenticatedStaff,
  ): Promise<void> {
    await this.prisma.variantMedia.deleteMany({ where: { variantId, mediaAssetId } });
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'variant.media.detach',
      entityType: 'ProductVariant',
      entityId: variantId,
      metadata: { mediaAssetId },
    });
  }

  private async assertProductExists(productId: string): Promise<void> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new ResourceNotFoundException('Product', productId);
    }
  }

  private async assertVariantExists(variantId: string): Promise<void> {
    const variant = await this.prisma.productVariant.findUnique({ where: { id: variantId } });
    if (!variant) {
      throw new ResourceNotFoundException('ProductVariant', variantId);
    }
  }
}
