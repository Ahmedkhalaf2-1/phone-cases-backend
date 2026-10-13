import { BadRequestException, Injectable } from '@nestjs/common';
import { BundleScope, Prisma } from '@prisma/client';
import { ResourceNotFoundException } from '../../../common/exceptions/app.exception';
import { buildPaginatedResult } from '../../../common/dto/paginated-result';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { BundleStatus, computeBundleStatus, resolveBundleSchedule } from './bundle-schedule.util';
import { BundlePricingConfig, DEFAULT_BUNDLE_SIZE } from './bundle-pricing.util';
import { BundleVariantOptionsQueryDto } from './dto/bundle-variant-options-query.dto';
import { CreateBundleDto } from './dto/create-bundle.dto';
import { UpdateBundleDto } from './dto/update-bundle.dto';

const NAME_SELECT = { select: { id: true, nameEn: true, nameAr: true } } as const;

const BUNDLE_INCLUDE = {
  eligibleVariants: {
    include: {
      variant: {
        include: {
          product: NAME_SELECT,
          phoneModel: { include: { brand: NAME_SELECT } },
          caseType: NAME_SELECT,
        },
      },
    },
  },
  scopeTargets: {
    include: {
      product: NAME_SELECT,
      collection: NAME_SELECT,
      caseType: NAME_SELECT,
      phoneBrand: NAME_SELECT,
      phoneModel: NAME_SELECT,
    },
  },
} satisfies Prisma.BundlePromotionInclude;

type BundleRow = Prisma.BundlePromotionGetPayload<{ include: typeof BUNDLE_INCLUDE }>;

/** Admin API shape: the stored bundle plus a flat, scope-agnostic `targets` list. */
export type BundleWithVariants = Omit<BundleRow, 'scopeTargets'> & {
  targets: { id: string; nameEn: string; nameAr: string }[];
  /** Server-computed lifecycle state; clients display it, never recompute it. */
  status: BundleStatus;
};

/** Scopes whose eligibility is a list of taxonomy/product ids (stored as BundleScopeTarget rows). */
type TargetScope = Exclude<BundleScope, 'ALL_PRODUCTS' | 'SPECIFIC_VARIANTS'>;

const TARGET_COLUMN = {
  PRODUCTS: 'productId',
  COLLECTIONS: 'collectionId',
  CASE_TYPES: 'caseTypeId',
  PHONE_BRANDS: 'phoneBrandId',
  PHONE_MODELS: 'phoneModelId',
} as const satisfies Record<TargetScope, string>;

function isTargetScope(scope: BundleScope): scope is TargetScope {
  return scope in TARGET_COLUMN;
}

/** Upper bound for "select all results" so one click cannot store an unbounded list. */
export const MAX_SELECT_ALL_IDS = 1000;

interface EffectiveBundleState {
  fixedTotal: number | null | undefined;
  currency: string | null | undefined;
  bundleSize: number;
  requireDifferentPhoneModels: boolean;
  scope: BundleScope;
  eligibleVariants: { variantId: string }[];
  targetIds: string[];
}

@Injectable()
export class BundlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateBundleDto, actor: AuthenticatedStaff): Promise<BundleWithVariants> {
    const scope = dto.scope ?? BundleScope.SPECIFIC_VARIANTS;
    const eligibleVariants = dto.eligibleVariants ?? [];
    const targetIds = dto.targetIds ?? [];
    this.assertScopeInputs(scope, eligibleVariants, targetIds);
    await this.assertTargetsExist(scope, targetIds);

    const schedule = resolveBundleSchedule(dto);

    const state: EffectiveBundleState = {
      fixedTotal: dto.fixedTotal,
      currency: dto.currency,
      bundleSize: dto.bundleSize ?? DEFAULT_BUNDLE_SIZE,
      requireDifferentPhoneModels: dto.requireDifferentPhoneModels ?? true,
      scope,
      eligibleVariants,
      targetIds,
    };
    if (dto.isEnabled) {
      await this.assertReadyToEnable(state);
    }

    const bundle = await this.prisma.bundlePromotion.create({
      data: {
        name: dto.name,
        fixedTotal: dto.fixedTotal,
        currency: dto.currency,
        bundleSize: dto.bundleSize,
        scope,
        requireDifferentPhoneModels: dto.requireDifferentPhoneModels,
        isRepeatable: dto.isRepeatable,
        allowCouponStacking: dto.allowCouponStacking,
        isEnabled: dto.isEnabled ?? false,
        startsAt: schedule.startsAt,
        expiresAt: schedule.expiresAt,
        eligibleVariants: {
          create: eligibleVariants.map((v) => ({
            variantId: v.variantId,
            surchargeAmount: v.surchargeAmount ?? 0,
          })),
        },
        scopeTargets: {
          create: isTargetScope(scope)
            ? targetIds.map((id) => ({ [TARGET_COLUMN[scope]]: id }))
            : [],
        },
      },
      include: BUNDLE_INCLUDE,
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'bundle.create',
      entityType: 'BundlePromotion',
      entityId: bundle.id,
      metadata: { name: bundle.name, isEnabled: bundle.isEnabled, scope: bundle.scope },
    });
    return this.toResponse(bundle);
  }

  async findAllForAdmin(): Promise<BundleWithVariants[]> {
    const rows = await this.prisma.bundlePromotion.findMany({
      include: BUNDLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toResponse(row));
  }

  async findByIdOrThrow(id: string): Promise<BundleWithVariants> {
    const bundle = await this.prisma.bundlePromotion.findUnique({
      where: { id },
      include: BUNDLE_INCLUDE,
    });
    if (!bundle) {
      throw new ResourceNotFoundException('BundlePromotion', id);
    }
    return this.toResponse(bundle);
  }

  private toResponse(row: BundleRow): BundleWithVariants {
    const { scopeTargets, ...rest } = row;
    const targets = scopeTargets.flatMap((target) => {
      const named =
        target.product ??
        target.collection ??
        target.caseType ??
        target.phoneBrand ??
        target.phoneModel;
      return named ? [{ id: named.id, nameEn: named.nameEn, nameAr: named.nameAr }] : [];
    });
    return { ...rest, targets, status: computeBundleStatus(rest) };
  }

  async update(
    id: string,
    dto: UpdateBundleDto,
    actor: AuthenticatedStaff,
  ): Promise<BundleWithVariants> {
    const existing = await this.findByIdOrThrow(id);

    const scope = dto.scope ?? existing.scope;
    const scopeChanged = scope !== existing.scope;

    // Stored eligibility only carries over while the scope is unchanged;
    // switching scope never silently keeps ids that belong to another one.
    const effectiveEligibleVariants =
      dto.eligibleVariants ??
      (scope === BundleScope.SPECIFIC_VARIANTS && !scopeChanged
        ? existing.eligibleVariants.map((v) => ({ variantId: v.variantId }))
        : []);
    const effectiveTargetIds =
      dto.targetIds ??
      (isTargetScope(scope) && !scopeChanged ? existing.targets.map((t) => t.id) : []);

    this.assertScopeInputs(scope, effectiveEligibleVariants, effectiveTargetIds);
    if (dto.targetIds) {
      await this.assertTargetsExist(scope, dto.targetIds);
    }

    const schedule = resolveBundleSchedule(dto, existing);

    const state: EffectiveBundleState = {
      fixedTotal: dto.fixedTotal ?? existing.fixedTotal,
      currency: dto.currency ?? existing.currency,
      bundleSize: dto.bundleSize ?? existing.bundleSize,
      requireDifferentPhoneModels:
        dto.requireDifferentPhoneModels ?? existing.requireDifferentPhoneModels,
      scope,
      eligibleVariants: effectiveEligibleVariants,
      targetIds: effectiveTargetIds,
    };
    if (dto.isEnabled ?? existing.isEnabled) {
      await this.assertReadyToEnable(state);
    }

    const bundle = await this.prisma.$transaction(async (tx) => {
      if (scopeChanged || dto.eligibleVariants) {
        await tx.bundleEligibleVariant.deleteMany({ where: { bundlePromotionId: id } });
        if (effectiveEligibleVariants.length > 0) {
          const surcharges = new Map(
            (dto.eligibleVariants ?? []).map((v) => [v.variantId, v.surchargeAmount ?? 0]),
          );
          await tx.bundleEligibleVariant.createMany({
            data: effectiveEligibleVariants.map((v) => ({
              bundlePromotionId: id,
              variantId: v.variantId,
              surchargeAmount: surcharges.get(v.variantId) ?? 0,
            })),
          });
        }
      }
      if (scopeChanged || dto.targetIds) {
        await tx.bundleScopeTarget.deleteMany({ where: { bundlePromotionId: id } });
        if (isTargetScope(scope) && effectiveTargetIds.length > 0) {
          await tx.bundleScopeTarget.createMany({
            data: effectiveTargetIds.map((targetId) => ({
              bundlePromotionId: id,
              [TARGET_COLUMN[scope]]: targetId,
            })),
          });
        }
      }

      return tx.bundlePromotion.update({
        where: { id },
        data: {
          name: dto.name,
          fixedTotal: dto.fixedTotal,
          currency: dto.currency,
          bundleSize: dto.bundleSize,
          scope: dto.scope,
          requireDifferentPhoneModels: dto.requireDifferentPhoneModels,
          isRepeatable: dto.isRepeatable,
          allowCouponStacking: dto.allowCouponStacking,
          isEnabled: dto.isEnabled,
          startsAt: schedule.startsAt,
          expiresAt: schedule.expiresAt,
        },
        include: BUNDLE_INCLUDE,
      });
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'bundle.update',
      entityType: 'BundlePromotion',
      entityId: bundle.id,
      metadata: { changes: dto },
    });
    return this.toResponse(bundle);
  }

  async delete(id: string, actor: AuthenticatedStaff): Promise<void> {
    await this.findByIdOrThrow(id);
    try {
      await this.prisma.bundlePromotion.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException(
          'This bundle has already been applied to at least one order and cannot be deleted - disable it instead',
        );
      }
      throw error;
    }
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'bundle.delete',
      entityType: 'BundlePromotion',
      entityId: id,
    });
  }

  async findActiveForPricing(now: Date = new Date()): Promise<BundlePricingConfig[]> {
    return this.prisma.$transaction((tx) => this.loadActiveForPricing(tx, now));
  }

  async findActiveForPricingInTransaction(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<BundlePricingConfig[]> {
    return this.loadActiveForPricing(tx, now);
  }

  private async loadActiveForPricing(
    tx: Prisma.TransactionClient,
    now: Date,
  ): Promise<BundlePricingConfig[]> {
    const rows = await tx.bundlePromotion.findMany({
      where: {
        isEnabled: true,
        fixedTotal: { not: null },
        currency: { not: null },
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
        ],
      },
      include: { eligibleVariants: true, scopeTargets: true },
      // Explicit and deterministic: when two or more active bundles are
      // eligible for the same physical unit, computeBundleInstances
      // processes them in exactly this order (earliest-configured bundle
      // gets first claim) - without an explicit orderBy here, Postgres
      // makes no row-order guarantee at all, which would make that
      // "deterministic ordering" claim false. See docs/DECISIONS.md.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return rows
      .filter((row) => {
        // Same completeness floor assertReadyToEnable enforces, re-checked
        // here so a bundle emptied after activation (e.g. its only
        // collection deleted) simply stops applying instead of matching
        // nothing in a confusing way.
        if (row.scope === BundleScope.ALL_PRODUCTS) return true;
        if (row.scope === BundleScope.SPECIFIC_VARIANTS) return row.eligibleVariants.length >= 2;
        return row.scopeTargets.length >= 1;
      })
      .map((row) => ({
        id: row.id,
        fixedTotal: row.fixedTotal as number,
        currency: row.currency as string,
        bundleSize: row.bundleSize,
        scope: row.scope,
        requireDifferentPhoneModels: row.requireDifferentPhoneModels,
        isRepeatable: row.isRepeatable,
        allowCouponStacking: row.allowCouponStacking,
        eligibleVariants: new Map(
          row.eligibleVariants.map((v) => [v.variantId, v.surchargeAmount]),
        ),
        targetIds: new Set(
          row.scopeTargets.flatMap((target) => {
            const targetId =
              target.productId ??
              target.collectionId ??
              target.caseTypeId ??
              target.phoneBrandId ??
              target.phoneModelId;
            return targetId ? [targetId] : [];
          }),
        ),
      }));
  }

  /**
   * "Require complete configuration before activation" (see
   * docs/DECISIONS.md): a bundle can only be enabled once it has a real
   * fixedTotal and currency, at least two eligible variants, and - when
   * requireDifferentPhoneModels is set - those variants actually span at
   * least two distinct phone models (including "no phone model" as its
   * own distinct bucket for plain accessories), so an enabled bundle can
   * always form at least one real pairing.
   */
  private async assertReadyToEnable(state: EffectiveBundleState): Promise<void> {
    if (state.fixedTotal === null || state.fixedTotal === undefined) {
      throw new BadRequestException(
        'Cannot enable a bundle with no fixedTotal configured - supply a real commercial value first',
      );
    }
    if (!state.currency) {
      throw new BadRequestException(
        'Cannot enable a bundle with no currency configured - supply a real commercial value first',
      );
    }

    if (state.scope === BundleScope.SPECIFIC_VARIANTS) {
      if (state.eligibleVariants.length < 2) {
        throw new BadRequestException(
          'Cannot enable a bundle with fewer than two eligible variants configured',
        );
      }
    } else if (isTargetScope(state.scope) && state.targetIds.length < 1) {
      throw new BadRequestException(
        'Cannot enable a bundle with no eligible products, collections, case types or phone models selected',
      );
    }

    if (!state.requireDifferentPhoneModels) {
      return;
    }

    // A "different phone models" bundle can only ever form if the eligible
    // set spans at least `bundleSize` distinct model buckets (no phone
    // model counts as its own bucket, for plain accessories).
    let distinctBuckets: number;
    if (state.scope === BundleScope.SPECIFIC_VARIANTS) {
      const variants = await this.prisma.productVariant.findMany({
        where: { id: { in: state.eligibleVariants.map((v) => v.variantId) } },
        select: { id: true, phoneModelId: true },
      });
      if (variants.length !== state.eligibleVariants.length) {
        throw new ResourceNotFoundException(
          'ProductVariant',
          state.eligibleVariants.map((v) => v.variantId).join(', '),
        );
      }
      distinctBuckets = new Set(variants.map((v) => v.phoneModelId ?? '__no_phone_model__')).size;
    } else {
      const groups = await this.prisma.productVariant.groupBy({
        by: ['phoneModelId'],
        where: { isActive: true, ...this.variantWhereForScope(state.scope, state.targetIds) },
      });
      distinctBuckets = groups.length;
    }
    if (distinctBuckets < state.bundleSize) {
      throw new BadRequestException(
        `Cannot enable a bundle that requires different phone models when its eligible variants do not span at least ${state.bundleSize} distinct phone models`,
      );
    }
  }

  /**
   * Only the storage matching `scope` may be populated: ALL_PRODUCTS
   * carries no ids at all, SPECIFIC_VARIANTS carries variants only, and
   * the target scopes carry targetIds only. Anything else is ambiguous
   * (which one wins?) and is rejected rather than guessed at.
   */
  private assertScopeInputs(
    scope: BundleScope,
    eligibleVariants: { variantId: string }[],
    targetIds: string[],
  ): void {
    const distinctVariants = new Set(eligibleVariants.map((v) => v.variantId));
    if (distinctVariants.size !== eligibleVariants.length) {
      throw new BadRequestException('eligibleVariants must not contain the same variant twice');
    }
    if (scope !== BundleScope.SPECIFIC_VARIANTS && eligibleVariants.length > 0) {
      throw new BadRequestException(
        `eligibleVariants can only be used with the SPECIFIC_VARIANTS scope, not ${scope}`,
      );
    }
    if (!isTargetScope(scope) && targetIds.length > 0) {
      throw new BadRequestException(
        `targetIds can only be used with the PRODUCTS, COLLECTIONS, CASE_TYPES, PHONE_BRANDS or PHONE_MODELS scopes, not ${scope}`,
      );
    }
  }

  private async assertTargetsExist(scope: BundleScope, targetIds: string[]): Promise<void> {
    if (!isTargetScope(scope) || targetIds.length === 0) {
      return;
    }
    const where = { id: { in: targetIds } };
    const select = { id: true };
    const found: { id: string }[] =
      scope === 'PRODUCTS'
        ? await this.prisma.product.findMany({ where, select })
        : scope === 'COLLECTIONS'
          ? await this.prisma.collection.findMany({ where, select })
          : scope === 'CASE_TYPES'
            ? await this.prisma.caseType.findMany({ where, select })
            : scope === 'PHONE_BRANDS'
              ? await this.prisma.phoneBrand.findMany({ where, select })
              : await this.prisma.phoneModel.findMany({ where, select });
    const foundIds = new Set(found.map((row) => row.id));
    const missing = targetIds.filter((targetId) => !foundIds.has(targetId));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown ${scope.toLowerCase().replace('_', ' ')} id(s): ${missing.join(', ')}`,
      );
    }
  }

  private variantWhereForScope(
    scope: BundleScope,
    targetIds: string[],
  ): Prisma.ProductVariantWhereInput {
    switch (scope) {
      case 'PRODUCTS':
        return { productId: { in: targetIds } };
      case 'COLLECTIONS':
        return { product: { collections: { some: { collectionId: { in: targetIds } } } } };
      case 'CASE_TYPES':
        return { caseTypeId: { in: targetIds } };
      case 'PHONE_BRANDS':
        return { phoneModel: { brandId: { in: targetIds } } };
      case 'PHONE_MODELS':
        return { phoneModelId: { in: targetIds } };
      default:
        return {};
    }
  }

  private variantOptionsWhere(
    query: BundleVariantOptionsQueryDto,
  ): Prisma.ProductVariantWhereInput {
    const q = query.q?.trim();
    return {
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.collectionId
        ? { product: { collections: { some: { collectionId: query.collectionId } } } }
        : {}),
      ...(query.caseTypeId ? { caseTypeId: query.caseTypeId } : {}),
      ...(query.phoneModelId ? { phoneModelId: query.phoneModelId } : {}),
      ...(query.phoneBrandId ? { phoneModel: { brandId: query.phoneBrandId } } : {}),
      ...(q
        ? {
            OR: [
              { sku: { contains: q, mode: 'insensitive' as const } },
              { product: { nameEn: { contains: q, mode: 'insensitive' as const } } },
              { product: { nameAr: { contains: q, mode: 'insensitive' as const } } },
              { phoneModel: { nameEn: { contains: q, mode: 'insensitive' as const } } },
              { caseType: { nameEn: { contains: q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
  }

  /**
   * Paginated, filterable variant lookup for the admin picker - so the
   * browser never downloads the whole catalog just to configure a bundle.
   */
  async listVariantOptions(query: BundleVariantOptionsQueryDto) {
    const where = this.variantOptionsWhere(query);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.productVariant.findMany({
        where,
        select: {
          id: true,
          sku: true,
          price: true,
          currency: true,
          isActive: true,
          product: NAME_SELECT,
          phoneModel: { select: { id: true, nameEn: true, nameAr: true, brand: NAME_SELECT } },
          caseType: NAME_SELECT,
        },
        orderBy: [{ product: { nameEn: 'asc' } }, { sku: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.productVariant.count({ where }),
    ]);
    return buildPaginatedResult(items, total, query.page, query.pageSize);
  }

  /**
   * Ids of every variant matching the same filters, for "select all N
   * results". All-or-nothing: when more than MAX_SELECT_ALL_IDS variants
   * match, this refuses instead of returning a silently partial list, so
   * "all results" can never quietly mean "the first 1000".
   */
  async listVariantOptionIds(
    query: BundleVariantOptionsQueryDto,
  ): Promise<{ ids: string[]; total: number }> {
    const where = this.variantOptionsWhere(query);
    const total = await this.prisma.productVariant.count({ where });
    if (total > MAX_SELECT_ALL_IDS) {
      throw new BadRequestException(
        `${total} variants match, which is more than the ${MAX_SELECT_ALL_IDS} that can be selected at once. ` +
          'Narrow the filters, or use the All products, Collections, Case types, Phone brands or Phone models scope instead.',
      );
    }
    const rows = await this.prisma.productVariant.findMany({
      where,
      select: { id: true },
      orderBy: [{ product: { nameEn: 'asc' } }, { sku: 'asc' }],
    });
    return { ids: rows.map((r) => r.id), total };
  }

  /** Readable details for specific variants (labels for an existing selection). */
  async listVariantsByIds(ids: string[]) {
    return this.prisma.productVariant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        sku: true,
        price: true,
        currency: true,
        isActive: true,
        product: NAME_SELECT,
        phoneModel: { select: { id: true, nameEn: true, nameAr: true, brand: NAME_SELECT } },
        caseType: NAME_SELECT,
      },
      orderBy: [{ product: { nameEn: 'asc' } }, { sku: 'asc' }],
    });
  }
}
