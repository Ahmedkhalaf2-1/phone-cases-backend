import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { MediaAsset, Prisma } from '@prisma/client';
import sharp from 'sharp';
import { ResourceNotFoundException } from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { AttachMediaDto } from './dto/attach-media.dto';
import { ReorderProductMediaDto } from './dto/reorder-media.dto';
import { UpdateProductMediaDto } from './dto/update-product-media.dto';
import { UploadMediaDto } from './dto/upload-media.dto';
import { MEDIA_STORAGE, MediaStorageDriver } from './storage/media-storage.interface';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Already-WebP and (possibly animated) GIF uploads are stored as-is: no
// lossy re-encode, no derivative.
const PASSTHROUGH_MIME_TYPES = new Set(['image/webp', 'image/gif']);
const DERIVATIVE_MIME_TYPE = 'image/webp';
const DERIVATIVE_QUALITY = 88;
const UNDECODABLE_MESSAGE =
  'The uploaded file could not be decoded as a valid image - it may be corrupt or mislabeled';

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

    let stored: { storageKey: string; url: string; originalStorageKey?: string };
    let mimeType: string;
    let fileSizeBytes: number;
    let width: number | undefined;
    let height: number | undefined;

    if (PASSTHROUGH_MIME_TYPES.has(file.mimetype)) {
      try {
        const metadata = await sharp(file.buffer).metadata();
        width = metadata.width;
        height = metadata.height;
      } catch {
        throw new BadRequestException(UNDECODABLE_MESSAGE);
      }
      stored = await this.storage.save(file.buffer, file.originalname, file.mimetype);
      mimeType = file.mimetype;
      fileSizeBytes = file.size;
    } else {
      // Encode before writing anything so an undecodable file leaves no
      // files behind. rotate() applies EXIF orientation to the pixels (the
      // WebP carries no EXIF), so the image looks the same; no resize/crop.
      let derivative: Buffer;
      try {
        const encoded = await sharp(file.buffer)
          .rotate()
          .webp({ quality: DERIVATIVE_QUALITY })
          .toBuffer({ resolveWithObject: true });
        derivative = encoded.data;
        width = encoded.info.width;
        height = encoded.info.height;
      } catch {
        throw new BadRequestException(UNDECODABLE_MESSAGE);
      }
      stored = await this.storage.saveWithOriginal(
        { buffer: file.buffer, mimeType: file.mimetype },
        { buffer: derivative, mimeType: DERIVATIVE_MIME_TYPE },
      );
      mimeType = DERIVATIVE_MIME_TYPE;
      fileSizeBytes = derivative.length;
    }

    let mediaAsset: MediaAsset;
    try {
      mediaAsset = await this.prisma.mediaAsset.create({
        data: {
          storageKey: stored.storageKey,
          url: stored.url,
          mimeType,
          fileSizeBytes,
          width,
          height,
          altTextEn: dto.altTextEn,
          altTextAr: dto.altTextAr,
          uploadedByStaffId: actor.id,
        },
      });
    } catch (error) {
      // Do not leave orphaned files behind a failed insert.
      await this.storage.delete(stored.storageKey);
      if (stored.originalStorageKey) {
        await this.storage.delete(stored.originalStorageKey);
      }
      throw error;
    }

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'media.upload',
      entityType: 'MediaAsset',
      entityId: mediaAsset.id,
      metadata: {
        mimeType,
        fileSizeBytes,
        originalMimeType: file.mimetype,
        originalFileSizeBytes: file.size,
      },
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

  /**
   * Sets displayOrder = array index for the given ids and makes the first
   * one primary, in a single transaction. The ids must be exactly the set
   * currently attached to the product - a partial list would leave the
   * remaining entries with colliding/ambiguous positions.
   */
  async reorderProductMedia(
    productId: string,
    dto: ReorderProductMediaDto,
    actor: AuthenticatedStaff,
  ): Promise<void> {
    await this.assertProductExists(productId);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.productMedia.findMany({
        where: { productId },
        select: { mediaAssetId: true },
      });
      const currentIds = new Set(current.map((entry) => entry.mediaAssetId));
      const matches =
        currentIds.size === dto.mediaAssetIds.length &&
        dto.mediaAssetIds.every((id) => currentIds.has(id));
      if (!matches) {
        throw new BadRequestException(
          'mediaAssetIds must list exactly the media assets currently attached to this product',
        );
      }
      for (let index = 0; index < dto.mediaAssetIds.length; index += 1) {
        await tx.productMedia.update({
          where: {
            productId_mediaAssetId: { productId, mediaAssetId: dto.mediaAssetIds[index] },
          },
          data: { displayOrder: index, isPrimary: index === 0 },
        });
      }
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'product.media.reorder',
      entityType: 'Product',
      entityId: productId,
      metadata: { mediaAssetIds: dto.mediaAssetIds },
    });
  }

  async updateProductMedia(
    productId: string,
    mediaAssetId: string,
    dto: UpdateProductMediaDto,
    actor: AuthenticatedStaff,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.productMedia.findUnique({
        where: { productId_mediaAssetId: { productId, mediaAssetId } },
      });
      if (!existing) {
        throw new ResourceNotFoundException('ProductMedia', mediaAssetId);
      }
      if (dto.isPrimary) {
        await tx.productMedia.updateMany({
          where: { productId, NOT: { mediaAssetId } },
          data: { isPrimary: false },
        });
      }
      await tx.productMedia.update({
        where: { productId_mediaAssetId: { productId, mediaAssetId } },
        data: {
          ...(dto.isPrimary ? { isPrimary: true } : {}),
          ...(dto.displayOrder !== undefined ? { displayOrder: dto.displayOrder } : {}),
        },
      });
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'product.media.update',
      entityType: 'Product',
      entityId: productId,
      metadata: { mediaAssetId, ...dto },
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
