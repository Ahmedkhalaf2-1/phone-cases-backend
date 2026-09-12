import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ResourceNotFoundException } from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { BundlePricingConfig } from './bundle-pricing.util';
import { CreateBundleDto } from './dto/create-bundle.dto';
import { UpdateBundleDto } from './dto/update-bundle.dto';

const BUNDLE_INCLUDE = {
  eligibleVariants: { include: { variant: { include: { phoneModel: true } } } },
} satisfies Prisma.BundlePromotionInclude;

export type BundleWithVariants = Prisma.BundlePromotionGetPayload<{
  include: typeof BUNDLE_INCLUDE;
}>;

interface EffectiveBundleState {
  fixedTotal: number | null | undefined;
  currency: string | null | undefined;
  requireDifferentPhoneModels: boolean;
  eligibleVariants: { variantId: string }[];
}

@Injectable()
export class BundlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateBundleDto, actor: AuthenticatedStaff): Promise<BundleWithVariants> {
    const eligibleVariants = dto.eligibleVariants ?? [];
    if (dto.isEnabled) {
      await this.assertReadyToEnable({
        fixedTotal: dto.fixedTotal,
        currency: dto.currency,
        requireDifferentPhoneModels: dto.requireDifferentPhoneModels ?? true,
        eligibleVariants,
      });
    }

    const bundle = await this.prisma.bundlePromotion.create({
      data: {
        name: dto.name,
        fixedTotal: dto.fixedTotal,
        currency: dto.currency,
        requireDifferentPhoneModels: dto.requireDifferentPhoneModels,
        isRepeatable: dto.isRepeatable,
        allowCouponStacking: dto.allowCouponStacking,
        isEnabled: dto.isEnabled ?? false,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        eligibleVariants: {
          create: eligibleVariants.map((v) => ({
            variantId: v.variantId,
            surchargeAmount: v.surchargeAmount ?? 0,
          })),
        },
      },
      include: BUNDLE_INCLUDE,
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'bundle.create',
      entityType: 'BundlePromotion',
      entityId: bundle.id,
      metadata: { name: bundle.name, isEnabled: bundle.isEnabled },
    });
    return bundle;
  }

  findAllForAdmin(): Promise<BundleWithVariants[]> {
    return this.prisma.bundlePromotion.findMany({
      include: BUNDLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByIdOrThrow(id: string): Promise<BundleWithVariants> {
    const bundle = await this.prisma.bundlePromotion.findUnique({
      where: { id },
      include: BUNDLE_INCLUDE,
    });
    if (!bundle) {
      throw new ResourceNotFoundException('BundlePromotion', id);
    }
    return bundle;
  }

  async update(
    id: string,
    dto: UpdateBundleDto,
    actor: AuthenticatedStaff,
  ): Promise<BundleWithVariants> {
    const existing = await this.findByIdOrThrow(id);

    const effectiveEligibleVariants =
      dto.eligibleVariants ?? existing.eligibleVariants.map((v) => ({ variantId: v.variantId }));
    const effectiveIsEnabled = dto.isEnabled ?? existing.isEnabled;
    const effectiveFixedTotal = dto.fixedTotal ?? existing.fixedTotal;
    const effectiveCurrency = dto.currency ?? existing.currency;
    const effectiveRequireDifferentPhoneModels =
      dto.requireDifferentPhoneModels ?? existing.requireDifferentPhoneModels;

    if (effectiveIsEnabled) {
      await this.assertReadyToEnable({
        fixedTotal: effectiveFixedTotal,
        currency: effectiveCurrency,
        requireDifferentPhoneModels: effectiveRequireDifferentPhoneModels,
        eligibleVariants: effectiveEligibleVariants,
      });
    }

    const bundle = await this.prisma.$transaction(async (tx) => {
      if (dto.eligibleVariants) {
        await tx.bundleEligibleVariant.deleteMany({ where: { bundlePromotionId: id } });
        if (dto.eligibleVariants.length > 0) {
          await tx.bundleEligibleVariant.createMany({
            data: dto.eligibleVariants.map((v) => ({
              bundlePromotionId: id,
              variantId: v.variantId,
              surchargeAmount: v.surchargeAmount ?? 0,
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
          requireDifferentPhoneModels: dto.requireDifferentPhoneModels,
          isRepeatable: dto.isRepeatable,
          allowCouponStacking: dto.allowCouponStacking,
          isEnabled: dto.isEnabled,
          startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
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
    return bundle;
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
      include: { eligibleVariants: true },
    });

    return rows
      .filter((row) => row.eligibleVariants.length >= 2)
      .map((row) => ({
        id: row.id,
        fixedTotal: row.fixedTotal as number,
        currency: row.currency as string,
        requireDifferentPhoneModels: row.requireDifferentPhoneModels,
        isRepeatable: row.isRepeatable,
        allowCouponStacking: row.allowCouponStacking,
        eligibleVariants: new Map(
          row.eligibleVariants.map((v) => [v.variantId, v.surchargeAmount]),
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
    if (state.eligibleVariants.length < 2) {
      throw new BadRequestException(
        'Cannot enable a bundle with fewer than two eligible variants configured',
      );
    }

    if (state.requireDifferentPhoneModels) {
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
      const distinctModelBuckets = new Set(
        variants.map((v) => v.phoneModelId ?? '__no_phone_model__'),
      );
      if (distinctModelBuckets.size < 2) {
        throw new BadRequestException(
          'Cannot enable a bundle that requires different phone models when its eligible variants do not span at least two distinct phone models',
        );
      }
    }
  }
}
