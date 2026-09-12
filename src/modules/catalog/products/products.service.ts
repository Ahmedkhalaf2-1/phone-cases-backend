import { Injectable } from '@nestjs/common';
import { Prisma, Product, ProductStatus } from '@prisma/client';
import {
  DuplicateResourceException,
  InvalidStateTransitionException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { buildPaginatedResult, PaginatedResult } from '../../../common/dto/paginated-result';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { AdminProductQueryDto } from './dto/admin-product-query.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductSort, PublicProductQueryDto } from './dto/public-product-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';

// Explicit status transition graph - see docs/BUSINESS_RULES.md.
// ARCHIVED products must go back through DRAFT before they can be
// published again, forcing a deliberate staff review of stale listings.
const ALLOWED_TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  [ProductStatus.DRAFT]: [ProductStatus.PUBLISHED, ProductStatus.ARCHIVED],
  [ProductStatus.PUBLISHED]: [ProductStatus.ARCHIVED],
  [ProductStatus.ARCHIVED]: [ProductStatus.DRAFT],
};

// Only the one image that will actually be shown (primary first, then
// lowest displayOrder), fetched directly at the DB level via `take: 1` -
// never the full media list just to pick one in application code.
const VARIANT_THUMBNAIL_INCLUDE = {
  include: { mediaAsset: true },
  orderBy: [{ isPrimary: 'desc' as const }, { displayOrder: 'asc' as const }],
  take: 1,
};

// Shared by every query that returns variants to a client (admin or
// public) - a variant with no image of its own still needs its parent
// product's own media loaded (see product-response.mapper.ts's
// product-image fallback), and every call site must agree on this shape
// to keep AdminProductWithRelations one consistent type.
const PRODUCT_VARIANT_RELATIONS_INCLUDE = {
  phoneModel: { include: { brand: true } },
  caseType: true,
  stockItem: true,
  media: VARIANT_THUMBNAIL_INCLUDE,
} satisfies Prisma.ProductVariantInclude;

const ADMIN_PRODUCT_INCLUDE = {
  variants: { include: PRODUCT_VARIANT_RELATIONS_INCLUDE },
  collections: { include: { collection: true } },
  media: { include: { mediaAsset: true }, orderBy: { displayOrder: 'asc' as const } },
} satisfies Prisma.ProductInclude;

export type AdminProductWithRelations = Prisma.ProductGetPayload<{
  include: typeof ADMIN_PRODUCT_INCLUDE;
}>;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateProductDto, actor: AuthenticatedStaff): Promise<Product> {
    try {
      const product = await this.prisma.product.create({ data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'product.create',
        entityType: 'Product',
        entityId: product.id,
        metadata: { slug: product.slug },
      });
      return product;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  async update(id: string, dto: UpdateProductDto, actor: AuthenticatedStaff): Promise<Product> {
    await this.findByIdOrThrow(id);
    try {
      const product = await this.prisma.product.update({ where: { id }, data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'product.update',
        entityType: 'Product',
        entityId: product.id,
        metadata: { changes: dto },
      });
      return product;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  async transitionStatus(
    id: string,
    targetStatus: ProductStatus,
    actor: AuthenticatedStaff,
  ): Promise<Product> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { variants: { where: { isActive: true } } },
    });
    if (!product) {
      throw new ResourceNotFoundException('Product', id);
    }

    if (product.status === targetStatus) {
      return product;
    }

    const allowed = ALLOWED_TRANSITIONS[product.status] ?? [];
    if (!allowed.includes(targetStatus)) {
      throw new InvalidStateTransitionException(
        `Cannot move product from ${product.status} to ${targetStatus}`,
      );
    }

    if (targetStatus === ProductStatus.PUBLISHED && product.variants.length === 0) {
      throw new InvalidStateTransitionException(
        'A product needs at least one active variant before it can be published',
      );
    }

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        status: targetStatus,
        publishedAt: targetStatus === ProductStatus.PUBLISHED ? new Date() : product.publishedAt,
      },
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: `product.status.${targetStatus.toLowerCase()}`,
      entityType: 'Product',
      entityId: product.id,
      metadata: { from: product.status, to: targetStatus },
    });

    return updated;
  }

  async findByIdOrThrow(id: string): Promise<Product> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) {
      throw new ResourceNotFoundException('Product', id);
    }
    return product;
  }

  async findByIdForAdmin(id: string): Promise<AdminProductWithRelations> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: ADMIN_PRODUCT_INCLUDE,
    });
    if (!product) {
      throw new ResourceNotFoundException('Product', id);
    }
    return product;
  }

  async findAllForAdmin(
    query: AdminProductQueryDto,
  ): Promise<PaginatedResult<AdminProductWithRelations>> {
    const where: Prisma.ProductWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.collectionId
        ? { collections: { some: { collectionId: query.collectionId } } }
        : {}),
      ...(query.q ? this.buildSearchFilter(query.q) : {}),
    };

    const [items, totalItems] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: ADMIN_PRODUCT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.product.count({ where }),
    ]);

    return buildPaginatedResult(items, totalItems, query.page, query.pageSize);
  }

  /**
   * Public catalog listing. Sorting (including by effective price) and
   * pagination are computed in two passes: first a lightweight query
   * collects candidate ids with just enough data to sort, then a second
   * query fetches full details only for the current page's ids. This
   * keeps queries index-friendly without needing a full SQL price
   * aggregation - acceptable at MVP catalog sizes. Revisit with a
   * materialized "effective price" column or window function if the
   * catalog grows large enough for this to matter (see docs/DECISIONS.md).
   */
  async findPublicList(
    query: PublicProductQueryDto,
  ): Promise<PaginatedResult<AdminProductWithRelations>> {
    const variantWhere = await this.buildPublicVariantFilter(query);
    const where: Prisma.ProductWhereInput = {
      status: ProductStatus.PUBLISHED,
      variants: { some: variantWhere },
      ...(query.collection
        ? { collections: { some: { collection: { slug: query.collection } } } }
        : {}),
      ...(query.q ? this.buildSearchFilter(query.q) : {}),
    };

    const candidates = await this.prisma.product.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        publishedAt: true,
        variants: {
          where: variantWhere,
          select: { price: true },
          orderBy: { price: 'asc' },
          take: 1,
        },
      },
    });

    const withEffectivePrice = candidates.map((candidate) => ({
      id: candidate.id,
      createdAt: candidate.createdAt,
      publishedAt: candidate.publishedAt,
      effectivePrice: candidate.variants[0]?.price ?? Number.MAX_SAFE_INTEGER,
    }));

    const sort = query.sort ?? ProductSort.NEWEST;
    withEffectivePrice.sort((a, b) => {
      if (sort === ProductSort.PRICE_ASC) return a.effectivePrice - b.effectivePrice;
      if (sort === ProductSort.PRICE_DESC) return b.effectivePrice - a.effectivePrice;
      const aDate = a.publishedAt ?? a.createdAt;
      const bDate = b.publishedAt ?? b.createdAt;
      return bDate.getTime() - aDate.getTime();
    });

    const totalItems = withEffectivePrice.length;
    const pageIds = withEffectivePrice.slice(query.skip, query.skip + query.take).map((c) => c.id);

    const products = await this.prisma.product.findMany({
      where: { id: { in: pageIds } },
      include: {
        variants: { where: variantWhere, include: PRODUCT_VARIANT_RELATIONS_INCLUDE },
        collections: { include: { collection: true } },
        media: { include: { mediaAsset: true }, orderBy: { displayOrder: 'asc' } },
      },
    });

    const byId = new Map(products.map((product) => [product.id, product]));
    const ordered = pageIds
      .map((id) => byId.get(id))
      .filter((product): product is AdminProductWithRelations => Boolean(product));

    return buildPaginatedResult(ordered, totalItems, query.page, query.pageSize);
  }

  async findPublicBySlug(slug: string): Promise<AdminProductWithRelations> {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: {
        variants: { where: { isActive: true }, include: PRODUCT_VARIANT_RELATIONS_INCLUDE },
        collections: { include: { collection: true } },
        media: { include: { mediaAsset: true }, orderBy: { displayOrder: 'asc' } },
      },
    });

    if (!product || product.status !== ProductStatus.PUBLISHED) {
      throw new ResourceNotFoundException('Product', slug);
    }

    return product;
  }

  async attachCollection(
    productId: string,
    collectionId: string,
    actor: AuthenticatedStaff,
  ): Promise<void> {
    await this.findByIdOrThrow(productId);
    try {
      await this.prisma.productCollection.create({ data: { productId, collectionId } });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'product.collection.attach',
        entityType: 'Product',
        entityId: productId,
        metadata: { collectionId },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new DuplicateResourceException(
            'PRODUCT_ALREADY_IN_COLLECTION',
            'This product is already part of that collection',
          );
        }
        if (error.code === 'P2003') {
          throw new ResourceNotFoundException('Collection', collectionId);
        }
      }
      throw error;
    }
  }

  async detachCollection(
    productId: string,
    collectionId: string,
    actor: AuthenticatedStaff,
  ): Promise<void> {
    await this.findByIdOrThrow(productId);
    await this.prisma.productCollection.deleteMany({ where: { productId, collectionId } });
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'product.collection.detach',
      entityType: 'Product',
      entityId: productId,
      metadata: { collectionId },
    });
  }

  private async buildPublicVariantFilter(
    query: PublicProductQueryDto,
  ): Promise<Prisma.ProductVariantWhereInput> {
    const base: Prisma.ProductVariantWhereInput = {
      isActive: true,
      ...(query.phoneModel ? { phoneModel: { slug: query.phoneModel } } : {}),
      ...(query.caseType ? { caseType: { slug: query.caseType } } : {}),
      ...(query.priceMin !== undefined || query.priceMax !== undefined
        ? {
            price: {
              ...(query.priceMin !== undefined ? { gte: query.priceMin } : {}),
              ...(query.priceMax !== undefined ? { lte: query.priceMax } : {}),
            },
          }
        : {}),
    };
    if (!query.availableOnly) {
      return base;
    }

    // Prisma's query API cannot compare two columns of the same row
    // (onHand vs reserved) directly, so a small raw query finds the stock
    // items that are genuinely available right now - the exact same
    // formula used everywhere else availability is decided (see
    // CartPricingService, product-response.mapper.ts). A variant with no
    // linked StockItem is only available if explicitly opted into
    // unlimited stock - never assumed just because stockItemId is null,
    // see docs/BUSINESS_RULES.md.
    const availableStockItems = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM stock_items WHERE "onHand" - reserved > 0;
    `);
    const availableStockItemIds = availableStockItems.map((row) => row.id);

    return {
      ...base,
      OR: [
        { stockItemId: null, isUnlimitedStock: true },
        { stockItemId: { in: availableStockItemIds } },
      ],
    };
  }

  private buildSearchFilter(q: string): Prisma.ProductWhereInput {
    return {
      OR: [
        { nameEn: { contains: q, mode: 'insensitive' } },
        { nameAr: { contains: q, mode: 'insensitive' } },
        { descriptionEn: { contains: q, mode: 'insensitive' } },
        { descriptionAr: { contains: q, mode: 'insensitive' } },
      ],
    };
  }

  private rethrowIfDuplicateSlug(error: unknown, slug: string | undefined): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && slug) {
      throw new DuplicateResourceException(
        'PRODUCT_SLUG_TAKEN',
        `A product with slug "${slug}" already exists`,
      );
    }
  }
}
