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
