import {
  BundlePricingConfig,
  BundleSourceLine,
  computeBundleInstances,
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
