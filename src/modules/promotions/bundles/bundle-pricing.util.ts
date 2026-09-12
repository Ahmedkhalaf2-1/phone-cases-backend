import { allocateDiscount } from '../../orders/order-pricing.util';

/** One bundle's configuration, already flattened for pure calculation - no Prisma types here. */
export interface BundlePricingConfig {
  id: string;
  fixedTotal: number;
  currency: string;
  requireDifferentPhoneModels: boolean;
  isRepeatable: boolean;
  allowCouponStacking: boolean;
  /** variantId -> explicit per-variant surcharge added on top of fixedTotal. */
  eligibleVariants: Map<string, number>;
}

/** One cart/order line, indexed by its position in the caller's own item array. */
export interface BundleSourceLine {
  lineIndex: number;
  variantId: string;
  phoneModelId: string | null;
  unitPrice: number;
  quantity: number;
  currency: string;
}

export interface BundleInstanceResult {
  bundlePromotionId: string;
  fixedTotalApplied: number;
  normalSubtotal: number;
  discountAmount: number;
  /** Exactly two entries - one per unit that formed this instance. */
  unitAllocations: { lineIndex: number; discount: number }[];
}

interface Unit {
  lineIndex: number;
  phoneModelId: string | null;
  price: number;
  surcharge: number;
}

/**
 * Groups eligible cart/order lines into two-item bundle instances and
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
 * one bundle. If a specific pairing would ever discount to a negative
 * amount (fixedTotal + surcharges exceeding the two units' normal price -
 * a misconfiguration), bundling for that promotion stops entirely rather
 * than ever increasing the payable total.
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

    const eligibleLines = lines.filter(
      (line) => bundle.eligibleVariants.has(line.variantId) && line.currency === bundle.currency,
    );
    if (eligibleLines.length === 0) {
      continue;
    }

    const units: Unit[] = [];
    for (const line of eligibleLines) {
      const surcharge = bundle.eligibleVariants.get(line.variantId) ?? 0;
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

    let formedAny = false;

    while (true) {
      if (!bundle.isRepeatable && formedAny) break;

      const nonEmpty = [...buckets.entries()].filter(([, bucket]) => bucket.length > 0);
      let unitA: Unit;
      let unitB: Unit;
      let keyA: string;
      let keyB: string;

      if (bundle.requireDifferentPhoneModels) {
        if (nonEmpty.length < 2) break;
        nonEmpty.sort(
          ([keyLeft, left], [keyRight, right]) =>
            right.length - left.length || (keyLeft < keyRight ? -1 : keyLeft > keyRight ? 1 : 0),
        );
        [keyA] = nonEmpty[0];
        [keyB] = nonEmpty[1];
        unitA = buckets.get(keyA)![0];
        unitB = buckets.get(keyB)![0];
      } else {
        const totalUnits = nonEmpty.reduce((sum, [, bucket]) => sum + bucket.length, 0);
        if (totalUnits < 2) break;
        [keyA] = nonEmpty[0];
        keyB = keyA;
        const bucket = buckets.get(keyA)!;
        unitA = bucket[0];
        unitB = bucket[1];
      }

      const normalSubtotal = unitA.price + unitB.price;
      const effectiveTotal = bundle.fixedTotal + unitA.surcharge + unitB.surcharge;
      const discountAmount = normalSubtotal - effectiveTotal;
      if (discountAmount < 0) {
        break;
      }

      if (keyA === keyB) {
        buckets.set(keyA, buckets.get(keyA)!.slice(2));
      } else {
        buckets.set(keyA, buckets.get(keyA)!.slice(1));
        buckets.set(keyB, buckets.get(keyB)!.slice(1));
      }

      // Claim these two units globally, across every bundle this call
      // processes - the next bundle in `bundles` (if any) must never see
      // them as still available, even though they remain untouched in
      // `lines` itself.
      remainingQuantityByLine.set(
        unitA.lineIndex,
        (remainingQuantityByLine.get(unitA.lineIndex) ?? 0) - 1,
      );
      remainingQuantityByLine.set(
        unitB.lineIndex,
        (remainingQuantityByLine.get(unitB.lineIndex) ?? 0) - 1,
      );

      const [discountA, discountB] = allocateDiscount([unitA.price, unitB.price], discountAmount);
      results.push({
        bundlePromotionId: bundle.id,
        fixedTotalApplied: effectiveTotal,
        normalSubtotal,
        discountAmount,
        unitAllocations: [
          { lineIndex: unitA.lineIndex, discount: discountA },
          { lineIndex: unitB.lineIndex, discount: discountB },
        ],
      });
      formedAny = true;
    }
  }

  return results;
}
