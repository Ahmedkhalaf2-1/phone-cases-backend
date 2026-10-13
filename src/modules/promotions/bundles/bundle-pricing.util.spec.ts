import {
  BundlePricingConfig,
  BundleSourceLine,
  computeBundleInstances,
  computeBundleProgress,
  guaranteedMinSavings,
} from './bundle-pricing.util';

function bundle(overrides: Partial<BundlePricingConfig> = {}): BundlePricingConfig {
  return {
    id: 'bundle-1',
    fixedTotal: 50000,
    currency: 'EGP',
    requireDifferentPhoneModels: true,
    isRepeatable: true,
    allowCouponStacking: false,
    eligibleVariants: new Map([
      ['variant-a', 0],
      ['variant-b', 0],
    ]),
    ...overrides,
  };
}

function line(overrides: Partial<BundleSourceLine>): BundleSourceLine {
  return {
    lineIndex: 0,
    variantId: 'variant-a',
    phoneModelId: 'model-a',
    unitPrice: 30000,
    quantity: 1,
    currency: 'EGP',
    ...overrides,
  };
}

describe('computeBundleInstances', () => {
  it('pairs two eligible units from different phone models and allocates the discount exactly', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', unitPrice: 30000 }),
      line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b', unitPrice: 35000 }),
    ];
    const result = computeBundleInstances(lines, [bundle()], { couponIsApplied: false });
    expect(result).toHaveLength(1);
    expect(result[0].normalSubtotal).toBe(65000);
    expect(result[0].fixedTotalApplied).toBe(50000);
    expect(result[0].discountAmount).toBe(15000);
    const total = result[0].unitAllocations.reduce((sum, a) => sum + a.discount, 0);
    expect(total).toBe(15000);
  });

  it('does not pair two units of the same phone model when different models are required', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', quantity: 2 }),
    ];
    const result = computeBundleInstances(lines, [bundle()], { couponIsApplied: false });
    expect(result).toHaveLength(0);
  });

  it('pairs same-model units when requireDifferentPhoneModels is false', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', quantity: 2 }),
    ];
    const result = computeBundleInstances(lines, [bundle({ requireDifferentPhoneModels: false })], {
      couponIsApplied: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].normalSubtotal).toBe(60000);
  });

  it('never produces a negative discount - skips bundling when fixedTotal plus surcharges would exceed normal price', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', unitPrice: 10000 }),
      line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b', unitPrice: 10000 }),
    ];
    // fixedTotal (50000) alone already exceeds the normal 20000 subtotal.
    const result = computeBundleInstances(lines, [bundle()], { couponIsApplied: false });
    expect(result).toHaveLength(0);
  });

  it('applies an explicit per-variant surcharge on top of fixedTotal', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', unitPrice: 60000 }),
      line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b', unitPrice: 30000 }),
    ];
    const surchargedBundle = bundle({
      eligibleVariants: new Map([
        ['variant-a', 5000],
        ['variant-b', 0],
      ]),
    });
    const result = computeBundleInstances(lines, [surchargedBundle], { couponIsApplied: false });
    expect(result).toHaveLength(1);
    expect(result[0].fixedTotalApplied).toBe(55000);
    expect(result[0].discountAmount).toBe(35000);
  });

  it('forms multiple instances when isRepeatable and enough eligible units exist, maximizing pair count', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', quantity: 3 }),
      line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b', quantity: 1 }),
    ];
    const result = computeBundleInstances(lines, [bundle()], { couponIsApplied: false });
    // Only 1 unit of model-b exists, so at most 1 pair can form even
    // though 3 units of model-a are eligible.
    expect(result).toHaveLength(1);
  });

  it('forms only one instance when isRepeatable is false, even with enough units for more', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', quantity: 2 }),
      line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b', quantity: 2 }),
    ];
    const result = computeBundleInstances(lines, [bundle({ isRepeatable: false })], {
      couponIsApplied: false,
    });
    expect(result).toHaveLength(1);
  });

  it('skips a bundle entirely when a coupon is applied and stacking is not allowed', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a' }),
      line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b' }),
    ];
    const result = computeBundleInstances(lines, [bundle({ allowCouponStacking: false })], {
      couponIsApplied: true,
    });
    expect(result).toHaveLength(0);
  });

  it('still applies the bundle alongside a coupon when stacking is explicitly allowed', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a' }),
      line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b' }),
    ];
    const result = computeBundleInstances(lines, [bundle({ allowCouponStacking: true })], {
      couponIsApplied: true,
    });
    expect(result).toHaveLength(1);
  });

  it('ignores lines in a different currency than the bundle', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', currency: 'USD' }),
      line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b', currency: 'USD' }),
    ];
    const result = computeBundleInstances(lines, [bundle({ currency: 'EGP' })], {
      couponIsApplied: false,
    });
    expect(result).toHaveLength(0);
  });

  it('ignores variants not explicitly listed as eligible', () => {
    const lines = [
      line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a' }),
      line({ lineIndex: 1, variantId: 'variant-not-eligible', phoneModelId: 'model-b' }),
    ];
    const result = computeBundleInstances(lines, [bundle()], { couponIsApplied: false });
    expect(result).toHaveLength(0);
  });

  describe('overlapping bundles competing for the same physical units', () => {
    it('never lets a second bundle claim a unit the first bundle already used', () => {
      // Only ONE unit of each variant exists - two different active
      // bundles are both eligible for the exact same pair. Before the
      // fix, each bundle independently rebuilt its own unit pool from
      // the raw `lines` array, so BOTH bundles could form an instance
      // from the same physical units - double-counting a discount on
      // merchandise that was only ever bought once.
      const lines = [
        line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', unitPrice: 30000 }),
        line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b', unitPrice: 35000 }),
      ];
      const bundleOne = bundle({ id: 'bundle-1', fixedTotal: 50000 });
      const bundleTwo = bundle({ id: 'bundle-2', fixedTotal: 40000 });

      const result = computeBundleInstances(lines, [bundleOne, bundleTwo], {
        couponIsApplied: false,
      });

      expect(result).toHaveLength(1);
      expect(result[0].bundlePromotionId).toBe('bundle-1');
      const totalUnitsUsed = result.reduce(
        (sum, instance) => sum + instance.unitAllocations.length,
        0,
      );
      expect(totalUnitsUsed).toBe(2);
    });

    it('resolves the overlap using the order bundles were given (earliest-configured first)', () => {
      const lines = [
        line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a' }),
        line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b' }),
      ];
      const bundleOne = bundle({ id: 'bundle-1' });
      const bundleTwo = bundle({ id: 'bundle-2' });

      const resultOneFirst = computeBundleInstances(lines, [bundleOne, bundleTwo], {
        couponIsApplied: false,
      });
      expect(resultOneFirst.map((r) => r.bundlePromotionId)).toEqual(['bundle-1']);

      const resultTwoFirst = computeBundleInstances(lines, [bundleTwo, bundleOne], {
        couponIsApplied: false,
      });
      expect(resultTwoFirst.map((r) => r.bundlePromotionId)).toEqual(['bundle-2']);
    });

    it('lets a second bundle claim units left over after the first bundle is satisfied', () => {
      // 2 units of each variant - bundle one (not repeatable) takes
      // exactly one pair, leaving one unit of each free for bundle two.
      const lines = [
        line({ lineIndex: 0, variantId: 'variant-a', phoneModelId: 'model-a', quantity: 2 }),
        line({ lineIndex: 1, variantId: 'variant-b', phoneModelId: 'model-b', quantity: 2 }),
      ];
      const bundleOne = bundle({ id: 'bundle-1', isRepeatable: false });
      const bundleTwo = bundle({ id: 'bundle-2' });

      const result = computeBundleInstances(lines, [bundleOne, bundleTwo], {
        couponIsApplied: false,
      });

      expect(result).toHaveLength(2);
      expect(result[0].bundlePromotionId).toBe('bundle-1');
      expect(result[1].bundlePromotionId).toBe('bundle-2');
    });
  });
});

describe('computeBundleInstances - eligibility scopes and bundle size', () => {
  // "Any 2 for 450 EGP" over the whole catalog: no variant list at all.
  const anyTwoFor450 = (overrides: Partial<BundlePricingConfig> = {}) =>
    bundle({
      id: 'any-2',
      fixedTotal: 45000,
      scope: 'ALL_PRODUCTS',
      requireDifferentPhoneModels: false,
      eligibleVariants: new Map(),
      ...overrides,
    });
  const total = (instances: ReturnType<typeof computeBundleInstances>) =>
    instances.reduce((sum, instance) => sum + instance.discountAmount, 0);
  const cartOf = (...prices: number[]) =>
    prices.map((unitPrice, i) =>
      line({ lineIndex: i, variantId: `never-listed-${i}`, unitPrice, phoneModelId: null }),
    );

  it('ALL_PRODUCTS matches variants that were never listed anywhere (e.g. created later)', () => {
    const result = computeBundleInstances(cartOf(30000, 30000), [anyTwoFor450()], {
      couponIsApplied: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].fixedTotalApplied).toBe(45000);
    expect(result[0].discountAmount).toBe(15000);
  });

  it('does nothing for a single eligible item', () => {
    expect(
      computeBundleInstances(cartOf(30000), [anyTwoFor450()], { couponIsApplied: false }),
    ).toEqual([]);
  });

  it('applies once to 3 items and leaves the third at normal price', () => {
    const result = computeBundleInstances(cartOf(30000, 30000, 30000), [anyTwoFor450()], {
      couponIsApplied: false,
    });
    expect(result).toHaveLength(1);
  });

  it('applies twice to 4 items when repeatable, once when not', () => {
    const items = cartOf(30000, 30000, 30000, 30000);
    expect(
      computeBundleInstances(items, [anyTwoFor450()], { couponIsApplied: false }),
    ).toHaveLength(2);
    expect(
      computeBundleInstances(items, [anyTwoFor450({ isRepeatable: false })], {
        couponIsApplied: false,
      }),
    ).toHaveLength(1);
  });

  it('never charges more than the normal price (two items totalling 400 with a 450 bundle)', () => {
    const result = computeBundleInstances(cartOf(20000, 20000), [anyTwoFor450()], {
      couponIsApplied: false,
    });
    expect(result).toEqual([]);
  });

  it('bundles the most expensive units first when prices differ', () => {
    // Cheap pair (400) would be negative; the 500+500 pair saves 550.
    const result = computeBundleInstances(cartOf(20000, 20000, 50000, 50000), [anyTwoFor450()], {
      couponIsApplied: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].normalSubtotal).toBe(100000);
    expect(result[0].discountAmount).toBe(55000);
    expect(result[0].unitAllocations.map((a) => a.lineIndex).sort()).toEqual([2, 3]);
  });

  it('never discounts below zero for any line allocation and total never exceeds subtotal', () => {
    const items = cartOf(33333, 41111, 50000, 27777, 90001);
    const result = computeBundleInstances(items, [anyTwoFor450()], { couponIsApplied: false });
    const subtotal = items.reduce((sum, i) => sum + i.unitPrice, 0);
    expect(total(result)).toBeLessThanOrEqual(subtotal);
    for (const instance of result) {
      expect(instance.discountAmount).toBeGreaterThanOrEqual(0);
      expect(instance.unitAllocations.reduce((s, a) => s + a.discount, 0)).toBe(
        instance.discountAmount,
      );
    }
  });

  it('respects coupon stacking policy for ALL_PRODUCTS bundles', () => {
    const items = cartOf(30000, 30000);
    expect(computeBundleInstances(items, [anyTwoFor450()], { couponIsApplied: true })).toEqual([]);
    expect(
      computeBundleInstances(items, [anyTwoFor450({ allowCouponStacking: true })], {
        couponIsApplied: true,
      }),
    ).toHaveLength(1);
  });

  it('ALL_PRODUCTS still honors requireDifferentPhoneModels', () => {
    const sameModel = [
      line({ lineIndex: 0, variantId: 'x', phoneModelId: 'm1', unitPrice: 30000 }),
      line({ lineIndex: 1, variantId: 'y', phoneModelId: 'm1', unitPrice: 30000 }),
    ];
    const diffModel = [
      line({ lineIndex: 0, variantId: 'x', phoneModelId: 'm1', unitPrice: 30000 }),
      line({ lineIndex: 1, variantId: 'y', phoneModelId: 'm2', unitPrice: 30000 }),
    ];
    const config = anyTwoFor450({ requireDifferentPhoneModels: true });
    expect(computeBundleInstances(sameModel, [config], { couponIsApplied: false })).toEqual([]);
    expect(computeBundleInstances(diffModel, [config], { couponIsApplied: false })).toHaveLength(1);
  });

  it('ignores ineligible items in a mixed cart under a specific scope', () => {
    const config = anyTwoFor450({
      scope: 'CASE_TYPES',
      targetIds: new Set(['case-shock']),
    });
    const items = [
      line({
        lineIndex: 0,
        variantId: 'a',
        caseTypeId: 'case-shock',
        unitPrice: 30000,
        phoneModelId: null,
      }),
      line({
        lineIndex: 1,
        variantId: 'b',
        caseTypeId: 'case-slim',
        unitPrice: 30000,
        phoneModelId: null,
      }),
      line({
        lineIndex: 2,
        variantId: 'c',
        caseTypeId: 'case-shock',
        unitPrice: 30000,
        phoneModelId: null,
      }),
    ];
    const result = computeBundleInstances(items, [config], { couponIsApplied: false });
    expect(result).toHaveLength(1);
    expect(result[0].unitAllocations.map((a) => a.lineIndex).sort()).toEqual([0, 2]);
  });

  it.each([
    ['PRODUCTS', { productId: 'p1' }, new Set(['p1']), new Set(['p9'])],
    ['COLLECTIONS', { collectionIds: ['c1', 'c2'] }, new Set(['c2']), new Set(['c9'])],
    ['PHONE_BRANDS', { phoneBrandId: 'b1' }, new Set(['b1']), new Set(['b9'])],
    ['PHONE_MODELS', { phoneModelId: 'pm1' }, new Set(['pm1']), new Set(['pm9'])],
  ] as [BundlePricingConfig['scope'], Partial<BundleSourceLine>, Set<string>, Set<string>][])(
    '%s scope matches only its targets',
    (scope, attrs, hit, miss) => {
      const items = [0, 1].map((i) =>
        line({ lineIndex: i, variantId: `v${i}`, unitPrice: 30000, ...attrs }),
      );
      const base = anyTwoFor450({ scope });
      expect(
        computeBundleInstances(items, [{ ...base, targetIds: new Set(hit) }], {
          couponIsApplied: false,
        }),
      ).toHaveLength(1);
      expect(
        computeBundleInstances(items, [{ ...base, targetIds: new Set(miss) }], {
          couponIsApplied: false,
        }),
      ).toEqual([]);
    },
  );

  it('SPECIFIC_VARIANTS still ignores unlisted variants and keeps surcharges', () => {
    const config = bundle({
      requireDifferentPhoneModels: false,
      eligibleVariants: new Map([
        ['variant-a', 5000],
        ['variant-b', 0],
      ]),
    });
    const items = [
      line({ lineIndex: 0, variantId: 'variant-a', unitPrice: 40000 }),
      line({ lineIndex: 1, variantId: 'variant-b', unitPrice: 40000 }),
      line({ lineIndex: 2, variantId: 'unlisted', unitPrice: 40000 }),
    ];
    const result = computeBundleInstances(items, [config], { couponIsApplied: false });
    expect(result).toHaveLength(1);
    expect(result[0].fixedTotalApplied).toBe(55000);
  });

  it('supports bundles larger than two units', () => {
    const config = anyTwoFor450({ bundleSize: 3, fixedTotal: 60000 });
    const result = computeBundleInstances(cartOf(30000, 30000, 30000, 30000), [config], {
      couponIsApplied: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].unitAllocations).toHaveLength(3);
    expect(result[0].discountAmount).toBe(30000);
  });

  it('size-3 bundles requiring different models need three distinct models', () => {
    const config = anyTwoFor450({
      bundleSize: 3,
      fixedTotal: 60000,
      requireDifferentPhoneModels: true,
    });
    const two = [
      line({ lineIndex: 0, variantId: 'a', phoneModelId: 'm1', unitPrice: 30000 }),
      line({ lineIndex: 1, variantId: 'b', phoneModelId: 'm2', unitPrice: 30000 }),
    ];
    expect(computeBundleInstances(two, [config], { couponIsApplied: false })).toEqual([]);
    const three = [
      ...two,
      line({ lineIndex: 2, variantId: 'c', phoneModelId: 'm3', unitPrice: 30000 }),
    ];
    expect(computeBundleInstances(three, [config], { couponIsApplied: false })).toHaveLength(1);
  });
});

describe('computeBundleProgress (storefront messaging, derived from the real grouping)', () => {
  // "Any 2 for 450" over the whole catalog; cheapest eligible case costs 250.
  const offer = (overrides: Partial<BundlePricingConfig> = {}): BundlePricingConfig => ({
    id: 'any-2',
    fixedTotal: 45000,
    currency: 'EGP',
    scope: 'ALL_PRODUCTS',
    requireDifferentPhoneModels: false,
    isRepeatable: true,
    allowCouponStacking: false,
    eligibleVariants: new Map(),
    minUnitPrice: 25000,
    maxSurcharge: 0,
    ...overrides,
  });
  const cart = (...prices: number[]) =>
    prices.map((unitPrice, i) =>
      line({ lineIndex: i, variantId: `v${i}`, phoneModelId: `m${i}`, unitPrice }),
    );
  const progress = (
    lines: BundleSourceLine[],
    bundles: BundlePricingConfig[] = [offer()],
    couponIsApplied = false,
  ) =>
    computeBundleProgress(
      lines,
      bundles,
      computeBundleInstances(lines, bundles, { couponIsApplied }),
      { couponIsApplied },
    );

  it('is null with no eligible item (empty cart, or nothing matches the offer)', () => {
    expect(progress([])).toBeNull();
    const specific = offer({ scope: 'SPECIFIC_VARIANTS', eligibleVariants: new Map([['x', 0]]) });
    expect(progress(cart(25000), [specific])).toBeNull();
  });

  it('1 eligible item: needs 1 more, with a proven saving (250 + 250 - 450 = 50)', () => {
    const result = progress(cart(25000))!;
    expect(result).toMatchObject({
      bundleSize: 2,
      fixedTotal: 45000,
      eligibleUnits: 1,
      groupsApplied: 0,
      unitsNeeded: 1,
      blockedByCoupon: false,
      savingsIfCompleted: 5000,
    });
  });

  it('uses the real price of what is already in the cart in the saving bound', () => {
    expect(progress(cart(30000))!.savingsIfCompleted).toBe(10000); // 300 + >=250 - 450
  });

  it('does not claim a saving it cannot prove', () => {
    expect(progress(cart(25000), [offer({ minUnitPrice: null })])!.savingsIfCompleted).toBeNull();
    // cheapest items are cheaper than the bundle price: no guaranteed saving
    expect(progress(cart(20000), [offer({ minUnitPrice: 20000 })])!.savingsIfCompleted).toBeNull();
  });

  it('2 eligible items: applied once, nothing outstanding to claim', () => {
    const result = progress(cart(25000, 25000))!;
    expect(result.groupsApplied).toBe(1);
    expect(result.eligibleUnits).toBe(2);
    expect(result.unitsNeeded).toBe(2); // a fresh group would need 2 more
  });

  it('4 eligible items, repeatable: two groups; 5 items: 2 groups and 1 more needed', () => {
    expect(progress(cart(25000, 25000, 25000, 25000))!.groupsApplied).toBe(2);
    const five = progress(cart(25000, 25000, 25000, 25000, 25000))!;
    expect(five.groupsApplied).toBe(2);
    expect(five.unitsNeeded).toBe(1);
  });

  it('non-repeatable offer: one group, then no further progress to suggest', () => {
    const result = progress(cart(25000, 25000, 25000, 25000), [offer({ isRepeatable: false })])!;
    expect(result.groupsApplied).toBe(1);
    expect(result.unitsNeeded).toBeNull();
    expect(result.savingsIfCompleted).toBeNull();
  });

  it('a coupon that blocks the bundle is reported instead of a false "applied"', () => {
    const result = progress(cart(25000, 25000), [offer()], true)!;
    expect(result.blockedByCoupon).toBe(true);
    expect(result.groupsApplied).toBe(0);
    expect(result.savingsIfCompleted).toBeNull();
    // when the offer allows stacking, the coupon does not block it
    const stacking = progress(cart(25000, 25000), [offer({ allowCouponStacking: true })], true)!;
    expect(stacking.blockedByCoupon).toBe(false);
    expect(stacking.groupsApplied).toBe(1);
  });

  it('different-phone-model offers count distinct models, not units', () => {
    const sameModel = [
      line({ lineIndex: 0, variantId: 'a', phoneModelId: 'm1', unitPrice: 25000 }),
      line({ lineIndex: 1, variantId: 'b', phoneModelId: 'm1', unitPrice: 25000 }),
    ];
    const result = progress(sameModel, [offer({ requireDifferentPhoneModels: true })])!;
    expect(result.requireDifferentPhoneModels).toBe(true);
    expect(result.groupsApplied).toBe(0);
    expect(result.eligibleUnits).toBe(2);
    expect(result.unitsNeeded).toBe(1); // one more, for a different model
  });

  it('per-variant surcharges are counted against the proven saving', () => {
    const surcharged = offer({ maxSurcharge: 3000 });
    // 2 * 250 - (450 + 2 * 30) = -10 -> cannot be proven
    expect(progress(cart(25000), [surcharged])!.savingsIfCompleted).toBeNull();
    expect(guaranteedMinSavings(surcharged)).toBe(0);
    expect(guaranteedMinSavings(offer())).toBe(5000);
  });

  it('with several offers, reports the one already applied (then the closest to completion)', () => {
    const cheapPair = offer({ id: 'pair', fixedTotal: 45000 });
    const triple = offer({ id: 'triple', bundleSize: 3, fixedTotal: 60000 });
    const lines = cart(25000, 25000);
    expect(progress(lines, [triple, cheapPair])!.bundleSize).toBe(2); // pair applied
    expect(progress(cart(25000), [triple, cheapPair])!.bundleSize).toBe(2); // needs 1 vs 2
  });
});
