/**
 * Idempotent production sync for the "Design Your Own Case" product and the
 * MALAK01 promo code. Safe to run any number of times.
 *
 *   npm run setup:custom-case-pricing            # apply
 *   DRY_RUN=1 npm run setup:custom-case-pricing  # only print what would change
 *
 * - every variant of the custom-case product: price = 250 EGP, customizationPrice = 0
 *   (the product's basePrice is kept in step)
 * - coupon MALAK01: FIXED, 50 EGP. Only `type` and `value` are written on an
 *   existing coupon; usageCount, usageLimit, minSpend, dates and isActive are left alone.
 *
 * Env: CUSTOM_CASE_SLUG (default custom-case). Amounts are integer minor units.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { CouponType, PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SLUG = process.env.CUSTOM_CASE_SLUG ?? 'custom-case';
const PRICE = 25000; // 250 EGP
const CUSTOMIZATION_PRICE = 0;
const COUPON_CODE = 'MALAK01';
const COUPON_VALUE = 5000; // 50 EGP
const DRY_RUN = process.env.DRY_RUN === '1';

async function syncVariants(): Promise<void> {
  const product = await prisma.product.findUnique({ where: { slug: SLUG } });
  if (!product) {
    console.log(`Product "${SLUG}": NOT FOUND - run "npm run seed:custom-case" first. Skipped.`);
    return;
  }

  const where = {
    productId: product.id,
    OR: [{ price: { not: PRICE } }, { customizationPrice: { not: CUSTOMIZATION_PRICE } }],
  };
  const total = await prisma.productVariant.count({ where: { productId: product.id } });
  const outdated = await prisma.productVariant.count({ where });
  const baseChanged = product.basePrice !== PRICE;

  console.log(
    `Product "${SLUG}": ${total} variant(s), ${outdated} to update ` +
      `(price -> ${PRICE}, customizationPrice -> ${CUSTOMIZATION_PRICE}); ` +
      `basePrice ${product.basePrice} ${baseChanged ? `-> ${PRICE}` : '(unchanged)'}`,
  );
  if (DRY_RUN) return;

  if (baseChanged) {
    await prisma.product.update({ where: { id: product.id }, data: { basePrice: PRICE } });
  }
  if (outdated > 0) {
    const result = await prisma.productVariant.updateMany({
      where,
      data: { price: PRICE, customizationPrice: CUSTOMIZATION_PRICE },
    });
    console.log(`  updated ${result.count} variant(s)`);
  }
}

async function syncCoupon(): Promise<void> {
  const existing = await prisma.coupon.findUnique({ where: { code: COUPON_CODE } });

  if (!existing) {
    console.log(`Coupon ${COUPON_CODE}: will be CREATED (FIXED ${COUPON_VALUE})`);
    if (DRY_RUN) return;
    await prisma.coupon.create({
      data: { code: COUPON_CODE, type: CouponType.FIXED, value: COUPON_VALUE },
    });
    return;
  }

  const needsUpdate = existing.type !== CouponType.FIXED || existing.value !== COUPON_VALUE;
  console.log(
    `Coupon ${COUPON_CODE}: exists (${existing.type} ${existing.value}, used ${existing.usageCount}) ` +
      (needsUpdate ? `-> will be set to FIXED ${COUPON_VALUE}` : '- already correct'),
  );
  if (!existing.isActive) {
    console.log(
      `  WARNING: ${COUPON_CODE} is inactive - left as is (not re-enabled automatically)`,
    );
  }
  if (DRY_RUN || !needsUpdate) return;
  await prisma.coupon.update({
    where: { code: COUPON_CODE },
    data: { type: CouponType.FIXED, value: COUPON_VALUE },
  });
}

async function main(): Promise<void> {
  if (DRY_RUN) console.log('DRY RUN - no changes will be written');
  await syncVariants();
  await syncCoupon();
  console.log(DRY_RUN ? 'Dry run complete.' : 'Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
