import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, ProductVariant } from '@prisma/client';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { getViolatedConstraintName } from '../../../common/utils/prisma-error.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';

@Injectable()
export class VariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(
    productId: string,
    dto: CreateVariantDto,
    actor: AuthenticatedStaff,
  ): Promise<ProductVariant> {
    await this.assertProductExists(productId);
    this.assertCompareAtPriceIsValid(dto.price, dto.compareAtPrice);
    this.assertStockConfigurationIsValid(dto.stockItemId, dto.isUnlimitedStock);

    try {
      const variant = await this.prisma.productVariant.create({
        data: { ...dto, productId },
      });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'product_variant.create',
        entityType: 'ProductVariant',
        entityId: variant.id,
        metadata: { productId, sku: variant.sku },
      });
      return variant;
    } catch (error) {
      this.rethrow(error, dto.sku);
      throw error;
    }
  }

  async findAllForProduct(productId: string): Promise<ProductVariant[]> {
    await this.assertProductExists(productId);
    return this.prisma.productVariant.findMany({
      where: { productId },
      include: { phoneModel: { include: { brand: true } }, caseType: true, stockItem: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOneForProduct(productId: string, variantId: string): Promise<ProductVariant> {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId },
      include: { phoneModel: { include: { brand: true } }, caseType: true, stockItem: true },
    });
    if (!variant) {
      throw new ResourceNotFoundException('ProductVariant', variantId);
    }
    return variant;
  }

  async update(
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
    actor: AuthenticatedStaff,
  ): Promise<ProductVariant> {
    const existing = await this.findOneForProduct(productId, variantId);
    this.assertCompareAtPriceIsValid(
      dto.price ?? existing.price,
      dto.compareAtPrice === undefined
        ? (existing.compareAtPrice ?? undefined)
        : dto.compareAtPrice,
    );
    this.assertStockConfigurationIsValid(
      dto.stockItemId === undefined ? (existing.stockItemId ?? undefined) : dto.stockItemId,
      dto.isUnlimitedStock === undefined ? existing.isUnlimitedStock : dto.isUnlimitedStock,
    );

    try {
      const variant = await this.prisma.productVariant.update({
        where: { id: variantId },
        data: dto,
      });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'product_variant.update',
        entityType: 'ProductVariant',
        entityId: variant.id,
        metadata: { changes: dto },
      });
      return variant;
    } catch (error) {
      this.rethrow(error, dto.sku);
      throw error;
    }
  }

  private assertCompareAtPriceIsValid(price: number, compareAtPrice: number | undefined): void {
    if (compareAtPrice !== undefined && compareAtPrice <= price) {
      throw new BadRequestException(
        'compareAtPrice must be greater than price to represent a genuine reference price',
      );
    }
  }

  /**
   * `isUnlimitedStock` only has meaning for a variant with no linked
   * StockItem - setting both together would leave it ambiguous whether
   * availability comes from the counter or the explicit opt-in, so it's
   * rejected outright rather than silently picking one interpretation.
   */
  private assertStockConfigurationIsValid(
    stockItemId: string | undefined,
    isUnlimitedStock: boolean | undefined,
  ): void {
    if (stockItemId && isUnlimitedStock) {
      throw new BadRequestException(
        'isUnlimitedStock cannot be true while stockItemId is set - a variant is either tracked ' +
          'by a StockItem or explicitly unlimited, not both',
      );
    }
  }

  private async assertProductExists(productId: string): Promise<void> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new ResourceNotFoundException('Product', productId);
    }
  }

  private rethrow(error: unknown, sku: string | undefined): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const target = getViolatedConstraintName(error);
        if (target.includes('sku')) {
          throw new DuplicateResourceException(
            'VARIANT_SKU_TAKEN',
            `SKU "${sku}" is already in use`,
          );
        }
        throw new DuplicateResourceException(
          'VARIANT_COMBINATION_EXISTS',
          'A variant with this phone model and case type combination already exists for this product',
        );
      }
      if (error.code === 'P2003') {
        throw new ResourceNotFoundException(
          'PhoneModel, CaseType or StockItem',
          'one of phoneModelId, caseTypeId or stockItemId',
        );
      }
    }
  }
}
