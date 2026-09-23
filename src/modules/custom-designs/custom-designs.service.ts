import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomDesign, ProductStatus } from '@prisma/client';
import { AppException, ResourceNotFoundException } from '../../common/exceptions/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ImageProcessingService } from './image-processing.service';
import { MockupService } from './mockup.service';
import { resolvePrintSpec } from './print-spec.util';
import {
  CUSTOM_DESIGN_STORAGE,
  CustomDesignStorageDriver,
} from './storage/custom-design-storage.interface';

export type CustomDesignFileKind = 'original' | 'print' | 'preview';

@Injectable()
export class CustomDesignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly imageProcessingService: ImageProcessingService,
    private readonly mockupService: MockupService,
    @Inject(CUSTOM_DESIGN_STORAGE) private readonly storage: CustomDesignStorageDriver,
  ) {}

  /**
   * Runs the full pipeline SYNCHRONOUSLY: validate the variant, decode/
   * validate the file, check minimum print resolution, render the
   * print-ready file (automatic center-crop+cover) and the mockup preview,
   * save all three, then create the row - in that order, so a CustomDesign
   * row only ever exists in a fully complete, usable state. Any failure
   * before the DB write leaves nothing behind; a failure AFTER files were
   * saved but before the DB write commits cleans those files back up.
   */
  async uploadForCart(
    cartId: string,
    variantId: string,
    file: Express.Multer.File,
  ): Promise<CustomDesign> {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { product: true, printSpecification: true },
    });
    if (!variant) {
      throw new ResourceNotFoundException('ProductVariant', variantId);
    }
    if (!variant.isActive || variant.product.status !== ProductStatus.PUBLISHED) {
      throw new AppException(
        'VARIANT_NOT_PURCHASABLE',
        'This variant is not currently purchasable',
        HttpStatus.CONFLICT,
      );
    }
    if (!variant.isPersonalizable) {
      throw new AppException(
        'VARIANT_NOT_PERSONALIZABLE',
        'This variant does not support personalized image printing',
        HttpStatus.CONFLICT,
      );
    }

    const maxPerCart = this.configService.getOrThrow<number>('CUSTOM_DESIGN_MAX_PER_CART');
    const existingCount = await this.prisma.customDesign.count({ where: { cartId } });
    if (existingCount >= maxPerCart) {
      throw new AppException(
        'TOO_MANY_CUSTOM_DESIGNS',
        `This cart already has ${existingCount} uploaded design(s) - the limit is ${maxPerCart}.`,
        HttpStatus.CONFLICT,
      );
    }

    const maxSize = this.configService.getOrThrow<number>('CUSTOM_DESIGN_MAX_FILE_SIZE_BYTES');
    const decoded = await this.imageProcessingService.decodeAndValidate(file, maxSize);

    const spec = resolvePrintSpec(variant.printSpecification);
    this.imageProcessingService.assertMeetsMinimumResolution(decoded, spec);

    const printBuffer = await this.imageProcessingService.renderPrintFile(decoded.buffer, spec);
    const previewBuffer = await this.mockupService.composePreview(printBuffer);

    const savedOriginal = await this.storage.save(decoded.buffer, decoded.mimeType);
    const savedFiles = [savedOriginal];
    try {
      const printMimeType = spec.outputFormat === 'PNG' ? 'image/png' : 'image/jpeg';
      const savedPrint = await this.storage.save(printBuffer, printMimeType);
      savedFiles.push(savedPrint);
      const savedPreview = await this.storage.save(previewBuffer, 'image/jpeg');
      savedFiles.push(savedPreview);

      const design = await this.prisma.customDesign.create({
        data: {
          cartId,
          variantId,
          originalStorageKey: savedOriginal.storageKey,
          originalMimeType: decoded.mimeType,
          originalSizeBytes: decoded.sizeBytes,
          originalWidth: decoded.width,
          originalHeight: decoded.height,
          printFileStorageKey: savedPrint.storageKey,
          printFileMimeType: printMimeType,
          printFileSizeBytes: printBuffer.byteLength,
          previewStorageKey: savedPreview.storageKey,
          previewMimeType: 'image/jpeg',
          previewSizeBytes: previewBuffer.byteLength,
          printWidthPx: spec.widthPx,
          printHeightPx: spec.heightPx,
          printDpi: spec.dpi,
          printSafeMarginPx: spec.safeMarginPx,
          printOutputFormat: spec.outputFormat,
          printOutputQuality: spec.outputQuality,
        },
      });

      await this.auditLogService.record({
        staffUserId: null,
        action: 'custom_design.upload',
        entityType: 'CustomDesign',
        entityId: design.id,
        metadata: { variantId, cartId },
      });

      return design;
    } catch (error) {
      await Promise.all(savedFiles.map((saved) => this.storage.delete(saved.storageKey)));
      throw error;
    }
  }

  async findOwnedOrThrow(cartId: string, designId: string): Promise<CustomDesign> {
    const design = await this.prisma.customDesign.findUnique({ where: { id: designId } });
    if (!design || design.cartId !== cartId) {
      throw new ResourceNotFoundException('CustomDesign', designId);
    }
    return design;
  }

  /**
   * The validation CartService needs before attaching a design to a cart
   * item: it exists, belongs to this cart, and was uploaded for exactly
   * this variant (a design's print file is rendered for one specific
   * variant's print spec - it can never be reused for a different one,
   * even a different personalizable variant of the same product). Also
   * returns whichever CartItem the design is currently attached to (if
   * any) so the caller can tell "already attached here" (no-op) apart from
   * "already attached to a different line" (rejected).
   */
  async assertOwnedReadyForVariant(
    cartId: string,
    designId: string,
    variantId: string,
  ): Promise<CustomDesign & { cartItem: { id: string } | null }> {
    const design = await this.prisma.customDesign.findUnique({
      where: { id: designId },
      include: { cartItem: { select: { id: true } } },
    });
    if (!design || design.cartId !== cartId) {
      throw new ResourceNotFoundException('CustomDesign', designId);
    }
    if (design.variantId !== variantId) {
      throw new AppException(
        'CUSTOM_DESIGN_VARIANT_MISMATCH',
        'This design was uploaded for a different variant and cannot be attached here - upload a new one for this variant instead',
        HttpStatus.CONFLICT,
      );
    }
    return design;
  }

  async getFileForCartOwner(
    cartId: string,
    designId: string,
    kind: CustomDesignFileKind,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const design = await this.findOwnedOrThrow(cartId, designId);
    return this.readFile(design, kind);
  }

  /** Staff access to any design attached to an order item - gated by role at the controller, never by ownership. */
  async getOrderItemFileForAdmin(
    orderItemId: string,
    kind: CustomDesignFileKind,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const snapshot = await this.prisma.orderItemCustomDesign.findUnique({
      where: { orderItemId },
    });
    if (!snapshot) {
      throw new ResourceNotFoundException('OrderItemCustomDesign', orderItemId);
    }
    return this.readFile(snapshot, kind);
  }

  private async readFile(
    files: {
      originalStorageKey: string;
      originalMimeType: string;
      printFileStorageKey: string;
      printFileMimeType: string;
      previewStorageKey: string;
      previewMimeType: string;
    },
    kind: CustomDesignFileKind,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const { storageKey, mimeType } =
      kind === 'original'
        ? { storageKey: files.originalStorageKey, mimeType: files.originalMimeType }
        : kind === 'print'
          ? { storageKey: files.printFileStorageKey, mimeType: files.printFileMimeType }
          : { storageKey: files.previewStorageKey, mimeType: files.previewMimeType };
    const buffer = await this.storage.read(storageKey);
    return { buffer, mimeType };
  }
}
