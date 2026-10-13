import { allocateDiscount } from '../../orders/order-pricing.util';

/** Mirrors the Prisma `BundleScope` enum - kept as a plain union so this file stays Prisma-free. */
export type BundleEligibilityScope =
  | 'SPECIFIC_VARIANTS'
  | 'ALL_PRODUCTS'
  | 'PRODUCTS'
  | 'COLLECTIONS'
  | 'CASE_TYPES'
  | 'PHONE_BRANDS'
  | 'PHONE_MODELS';

/** Units per bundle instance when a config does not say otherwise (the original pair). */
export const DEFAULT_BUNDLE_SIZE = 2;

/** One bundle's configuration, already flattened for pure calculation - no Prisma types here. */
export interface BundlePricingConfig {
  id: string;
  fixedTotal: number;
  currency: string;
  requireDifferentPhoneModels: boolean;
  isRepeatable: boolean;
  allowCouponStacking: boolean;
  /**
   * variantId -> explicit per-variant surcharge added on top of fixedTotal.
   * Only consulted for the SPECIFIC_VARIANTS scope.
   */
  eligibleVariants: Map<string, number>;
  /** Defaults to SPECIFIC_VARIANTS (the original behavior). */
  scope?: BundleEligibilityScope;
  /** Ids of the products/collections/case types/brands/models for the matching scope. */
  targetIds?: Set<string>;
  /** Units that make up one instance; defaults to DEFAULT_BUNDLE_SIZE. */
  bundleSize?: number;
  /**
   * Display-only (never read by pricing): the cheapest price any eligible
   * unit can have, and the largest per-unit surcharge. They let storefront
   * messaging state a *guaranteed minimum* saving without claiming more.
   */
  minUnitPrice?: number | null;
  maxSurcharge?: number;
  /** Display-only cache key: changes whenever the bundle is edited. */
  revision?: number;
}

/** One cart/order line, indexed by its position in the caller's own item array. */
export interface BundleSourceLine {
  lineIndex: number;
  variantId: string;
  phoneModelId: string | null;
  unitPrice: number;
  quantity: number;
  currency: string;
  /** Catalog attributes used by the non-variant scopes; absent means "unknown, never matches". */
  productId?: string;
  caseTypeId?: string | null;
  phoneBrandId?: string | null;
  collectionIds?: string[];
}

export interface BundleInstanceResult {
  bundlePromotionId: string;
  fixedTotalApplied: number;
  normalSubtotal: number;
  discountAmount: number;
  /** One entry per unit that formed this instance (bundleSize entries). */
  unitAllocations: { lineIndex: number; discount: number }[];
}

/**
 * Whether a cart line may fill a slot in `bundle`. Evaluated against the
 * line's live catalog attributes at pricing time - nothing about "all
 * products" or a collection is ever snapshotted into the bundle.
 */
export function isLineEligible(line: BundleSourceLine, bundle: BundlePricingConfig): boolean {
  const targets = bundle.targetIds ?? new Set<string>();
  switch (bundle.scope ?? 'SPECIFIC_VARIANTS') {
    case 'ALL_PRODUCTS':
      return true;
    case 'SPECIFIC_VARIANTS':
      return bundle.eligibleVariants.has(line.variantId);
    case 'PRODUCTS':
      return line.productId !== undefined && targets.has(line.productId);
    case 'COLLECTIONS':
      return (line.collectionIds ?? []).some((id) => targets.has(id));
    case 'CASE_TYPES':
      return Boolean(line.caseTypeId) && targets.has(line.caseTypeId as string);
    case 'PHONE_BRANDS':
      return Boolean(line.phoneBrandId) && targets.has(line.phoneBrandId as string);
    case 'PHONE_MODELS':
      return Boolean(line.phoneModelId) && targets.has(line.phoneModelId as string);
    default:
      return false;
  }
}

interface Unit {
  lineIndex: number;
  phoneModelId: string | null;
  price: number;
  surcharge: number;
}

/**
 * Groups eligible cart/order lines into bundle instances of
 * `bundleSize` units (default 2) and
 * computes each instance's discount, deterministically. Pure and
 * side-effect-free so the exact same calculation runs for a cart's live
 * pricing view, a checkout quote, AND order creation - see
 * CartPricingService.buildView and OrdersService.createOrder, which both
 * call this instead of each re-implementing their own grouping.
 *
 * Grouping algorithm within one bundle (a deliberate, documented choice -
 * see docs/DECISIONS.md): eligible units are bucketed by phoneModelId (or
 * a single bucket when requireDifferentPhoneModels is false). Each round,
 * the two largest buckets are paired (ties broken by bucket key, then by
 * the earliest-added unit within a bucket) - the standard greedy strategy
 * for maximizing the number of pairs formed across categories WITHIN that
 * one bundle. Within a bucket, units are taken highest price first, so a
 * fixed price over mixed-price items (e.g. "any 2 for 450" over a cart of
 * 200/200/500/500) discounts the expensive units instead of stalling on a
 * cheap pair. If a specific grouping would ever discount to a negative
 * amount (fixedTotal + surcharges exceeding the units' normal price - a
 * misconfiguration, or a fixed price above the items' normal cost),
 * bundling for that promotion stops entirely rather than ever increasing
 * the payable total.
 *
 * Ordering ACROSS bundles when several are active and eligible for the
 * same physical units (a deliberate, documented choice, NOT a claim of
 * globally maximal savings - see docs/DECISIONS.md): bundles are
 * processed strictly in the order given in `bundles` (the caller -
 * BundlesService.loadActiveForPricing - orders them by `createdAt` then
 * `id` ascending, so the earliest-configured active bundle gets first
 * claim). A running `remainingQuantityByLine` count, shared across every
 * bundle processed in this call, is decremented every time a unit is
 * consumed by an instance - so a later bundle in the list only ever sees
 * the units earlier bundles left unclaimed. This guarantees one physical
 * unit can belong to at most one bundle instance across ALL applied
 * promotions, never more.
 */
export function computeBundleInstances(
  lines: BundleSourceLine[],
  bundles: BundlePricingConfig[],
  options: { couponIsApplied: boolean },
): BundleInstanceResult[] {
  const results: BundleInstanceResult[] = [];
  const remainingQuantityByLine = new Map<number, number>(
    lines.map((line) => [line.lineIndex, line.quantity]),
  );

  for (const bundle of bundles) {
    if (options.couponIsApplied && !bundle.allowCouponStacking) {
      continue;
    }

    const size = bundle.bundleSize ?? DEFAULT_BUNDLE_SIZE;
    if (size < 2) {
      continue;
    }
    const isVariantScope = (bundle.scope ?? 'SPECIFIC_VARIANTS') === 'SPECIFIC_VARIANTS';

    const eligibleLines = lines.filter(
      (line) => line.currency === bundle.currency && isLineEligible(line, bundle),
    );
    if (eligibleLines.length === 0) {
      continue;
    }

    const units: Unit[] = [];
    for (const line of eligibleLines) {
      const surcharge = isVariantScope ? (bundle.eligibleVariants.get(line.variantId) ?? 0) : 0;
      const remaining = remainingQuantityByLine.get(line.lineIndex) ?? 0;
      for (let i = 0; i < remaining; i += 1) {
        units.push({
          lineIndex: line.lineIndex,
          phoneModelId: line.phoneModelId,
          price: line.unitPrice,
          surcharge,
        });
      }
    }

    const bucketKeyOf = (unit: Unit): string =>
      bundle.requireDifferentPhoneModels ? (unit.phoneModelId ?? '__no_phone_model__') : '__all__';

    const buckets = new Map<string, Unit[]>();
    for (const unit of units) {
      const key = bucketKeyOf(unit);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(unit);
      } else {
        buckets.set(key, [unit]);
      }
    }
    // Highest price first within each bucket (stable, so equal prices keep
    // cart order and existing equal-price behavior is unchanged).
    for (const bucket of buckets.values()) {
      bucket.sort((left, right) => right.price - left.price);
    }

    let formedAny = false;

    while (true) {
      if (!bundle.isRepeatable && formedAny) break;

      const nonEmpty = [...buckets.entries()].filter(([, bucket]) => bucket.length > 0);
      const chosen: { key: string; unit: Unit }[] = [];

      if (bundle.requireDifferentPhoneModels) {
        // One unit from each of the `size` largest distinct-model buckets.
        if (nonEmpty.length < size) break;
        nonEmpty.sort(
          ([keyLeft, left], [keyRight, right]) =>
            right.length - left.length || (keyLeft < keyRight ? -1 : keyLeft > keyRight ? 1 : 0),
        );
        for (const [key, bucket] of nonEmpty.slice(0, size)) {
          chosen.push({ key, unit: bucket[0] });
        }
      } else {
        const totalUnits = nonEmpty.reduce((sum, [, bucket]) => sum + bucket.length, 0);
        if (totalUnits < size) break;
        const [key, bucket] = nonEmpty[0];
        for (const unit of bucket.slice(0, size)) {
          chosen.push({ key, unit });
        }
      }

      const chosenUnits = chosen.map((entry) => entry.unit);
      const normalSubtotal = chosenUnits.reduce((sum, unit) => sum + unit.price, 0);
      const effectiveTotal =
        bundle.fixedTotal + chosenUnits.reduce((sum, unit) => sum + unit.surcharge, 0);
      const discountAmount = normalSubtotal - effectiveTotal;
      if (discountAmount < 0) {
        break;
      }

      // Same bucket (requireDifferentPhoneModels false) consumes `size`
      // units from it; otherwise one unit from each chosen bucket.
      if (bundle.requireDifferentPhoneModels) {
        for (const { key } of chosen) {
          buckets.set(key, buckets.get(key)!.slice(1));
        }
      } else {
        buckets.set(chosen[0].key, buckets.get(chosen[0].key)!.slice(size));
      }

      // Claim these units globally, across every bundle this call
      // processes - the next bundle in `bundles` (if any) must never see
      // them as still available, even though they remain untouched in
      // `lines` itself.
      for (const unit of chosenUnits) {
        remainingQuantityByLine.set(
          unit.lineIndex,
          (remainingQuantityByLine.get(unit.lineIndex) ?? 0) - 1,
        );
      }

      const allocations = allocateDiscount(
        chosenUnits.map((unit) => unit.price),
        discountAmount,
      );
      results.push({
        bundlePromotionId: bundle.id,
        fixedTotalApplied: effectiveTotal,
        normalSubtotal,
        discountAmount,
        unitAllocations: chosenUnits.map((unit, index) => ({
          lineIndex: unit.lineIndex,
          discount: allocations[index],
        })),
      });
      formedAny = true;
    }
  }

  return results;
}

/**
 * What the storefront needs to explain the offer a cart is working
 * towards. Derived from the SAME eligibility function and the SAME
 * grouping result the discount uses - nothing here is recomputed by the
 * client and nothing in it changes what is charged.
 */
export interface BundleProgress {
  bundleSize: number;
  /** Price of one group, minor units (per-variant surcharges excluded). */
  fixedTotal: number;
  currency: string;
  requireDifferentPhoneModels: boolean;
  isRepeatable: boolean;
  allowCouponStacking: boolean;
  /** Eligible units currently in the cart. */
  eligibleUnits: number;
  /** Groups actually discounted right now (from computeBundleInstances). */
  groupsApplied: number;
  /**
   * Eligible units still missing for the next group. null when no further
   * group is possible/provable (e.g. a non-repeatable offer already
   * applied, or enough units that the pricing rules still declined).
   */
  unitsNeeded: number | null;
  /** A coupon is applied and this bundle may not stack with it: the bundle is skipped. */
  blockedByCoupon: boolean;
  /** Guaranteed minimum saving for completing the next group, only when provably > 0. */
  savingsIfCompleted: number | null;
}

/**
 * Guaranteed minimum saving of any complete group of this offer: the
 * cheapest possible `bundleSize` units minus the group price (and the
 * worst-case surcharges). 0 whenever that cannot be proven positive.
 */
export function guaranteedMinSavings(bundle: BundlePricingConfig): number {
  const size = bundle.bundleSize ?? DEFAULT_BUNDLE_SIZE;
  if (bundle.minUnitPrice === null || bundle.minUnitPrice === undefined) return 0;
  const worst = bundle.fixedTotal + size * (bundle.maxSurcharge ?? 0);
  return Math.max(0, size * bundle.minUnitPrice - worst);
}

/**
 * Picks the single offer the cart is closest to / already benefiting from:
 * most groups applied first, then fewest units still needed, then the
 * lowest price per unit. Returns null when the cart has no eligible item
 * for any active bundle.
 */
export function computeBundleProgress(
  lines: BundleSourceLine[],
  bundles: BundlePricingConfig[],
  instances: BundleInstanceResult[],
  options: { couponIsApplied: boolean },
): BundleProgress | null {
  if (bundles.length === 0 || lines.length === 0) return null;

  // Units already consumed by ANY applied instance, per cart line.
  const consumedByLine = new Map<number, number>();
  for (const instance of instances) {
    for (const allocation of instance.unitAllocations) {
      consumedByLine.set(allocation.lineIndex, (consumedByLine.get(allocation.lineIndex) ?? 0) + 1);
    }
  }

  const candidates: { progress: BundleProgress; perUnit: number }[] = [];

  for (const bundle of bundles) {
    const size = bundle.bundleSize ?? DEFAULT_BUNDLE_SIZE;
    if (size < 2) continue;
    const eligibleLines = lines.filter(
      (line) => line.currency === bundle.currency && isLineEligible(line, bundle),
    );
    const eligibleUnits = eligibleLines.reduce((sum, line) => sum + line.quantity, 0);
    if (eligibleUnits === 0) continue;

    const blockedByCoupon = options.couponIsApplied && !bundle.allowCouponStacking;
    const groupsApplied = instances.filter((i) => i.bundlePromotionId === bundle.id).length;

    // Eligible units not consumed by any applied group.
    const free: { price: number; phoneModelId: string | null }[] = [];
    for (const line of eligibleLines) {
      const left = line.quantity - (consumedByLine.get(line.lineIndex) ?? 0);
      for (let i = 0; i < left; i += 1) {
        free.push({ price: line.unitPrice, phoneModelId: line.phoneModelId });
      }
    }

    let unitsNeeded: number | null;
    let leftoverPrice = 0;
    if (!bundle.isRepeatable && groupsApplied > 0) {
      unitsNeeded = null;
    } else if (bundle.requireDifferentPhoneModels) {
      const cheapestPerModel = new Map<string, number>();
      for (const unit of free) {
        const key = unit.phoneModelId ?? '__no_phone_model__';
        const current = cheapestPerModel.get(key);
        if (current === undefined || unit.price < current) cheapestPerModel.set(key, unit.price);
      }
      unitsNeeded = cheapestPerModel.size >= size ? null : size - cheapestPerModel.size;
      leftoverPrice = [...cheapestPerModel.values()].reduce((sum, price) => sum + price, 0);
    } else {
      unitsNeeded = free.length >= size ? null : size - free.length;
      leftoverPrice = free.reduce((sum, unit) => sum + unit.price, 0);
    }

    let savingsIfCompleted: number | null = null;
    if (
      unitsNeeded !== null &&
      !blockedByCoupon &&
      bundle.minUnitPrice !== null &&
      bundle.minUnitPrice !== undefined
    ) {
      // Lower bound: units already in the cart at their real price, the
      // missing ones at the cheapest eligible price, worst-case surcharges.
      const lowestGroupPrice = leftoverPrice + unitsNeeded * bundle.minUnitPrice;
      const highestGroupCost = bundle.fixedTotal + size * (bundle.maxSurcharge ?? 0);
      const saving = lowestGroupPrice - highestGroupCost;
      savingsIfCompleted = saving > 0 ? saving : null;
    }

    candidates.push({
      perUnit: bundle.fixedTotal / size,
      progress: {
        bundleSize: size,
        fixedTotal: bundle.fixedTotal,
        currency: bundle.currency,
        requireDifferentPhoneModels: bundle.requireDifferentPhoneModels,
        isRepeatable: bundle.isRepeatable,
        allowCouponStacking: bundle.allowCouponStacking,
        eligibleUnits,
        groupsApplied: blockedByCoupon ? 0 : groupsApplied,
        unitsNeeded,
        blockedByCoupon,
        savingsIfCompleted,
      },
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      b.progress.groupsApplied - a.progress.groupsApplied ||
      (a.progress.unitsNeeded ?? Number.POSITIVE_INFINITY) -
        (b.progress.unitsNeeded ?? Number.POSITIVE_INFINITY) ||
      a.perUnit - b.perUnit,
  );
  return candidates[0].progress;
}
