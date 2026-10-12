/* eslint-disable no-console */
/**
 * Idempotently creates the published "custom-case" product that the
 * storefront's /customize page opens: one personalizable, unlimited-stock
 * variant per active phone model x chosen case type.
 *
 *   npm run seed:custom-case            # create / top up missing variants
 *   DRY_RUN=1 npm run seed:custom-case  # only print what would happen
 *
 * Env: CUSTOM_CASE_SLUG (default custom-case), CUSTOM_CASE_CASE_TYPE (case
 * type slug; default = first active case type), CUSTOM_CASE_PRICE and
 * CUSTOM_CASE_CUSTOMIZATION_PRICE (integer minor units).
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ProductStatus } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SLUG = process.env.CUSTOM_CASE_SLUG ?? 'custom-case';
const PRICE = Number(process.env.CUSTOM_CASE_PRICE ?? 25000);
const CUSTOMIZATION_PRICE = Number(process.env.CUSTOM_CASE_CUSTOMIZATION_PRICE ?? 0);
const DRY_RUN = process.env.DRY_RUN === '1';

async function main(): Promise<void> {
  const caseType = process.env.CUSTOM_CASE_CASE_TYPE
    ? await prisma.caseType.findUnique({ where: { slug: process.env.CUSTOM_CASE_CASE_TYPE } })
    : await prisma.caseType.findFirst({
        where: { isActive: true },
        orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
      });
  if (!caseType)
    throw new Error('No case type found - create one first or set CUSTOM_CASE_CASE_TYPE');

  const phoneModels = await prisma.phoneModel.findMany({
    where: { isActive: true, brand: { isActive: true } },
    orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
  });
  console.log(
    `Case type: ${caseType.slug}; active phone models: ${phoneModels.length}; ` +
      `price ${PRICE}, customization +${CUSTOMIZATION_PRICE}`,
  );

  const existing = await prisma.product.findUnique({
    where: { slug: SLUG },
    include: { variants: { select: { phoneModelId: true, caseTypeId: true } } },
  });
  const have = new Set((existing?.variants ?? []).map((v) => `${v.phoneModelId}:${v.caseTypeId}`));
  const missing = phoneModels.filter((m) => !have.has(`${m.id}:${caseType.id}`));
  console.log(
    `${existing ? 'Product exists' : 'Product will be created'}; ` +
      `${missing.length} variant(s) to add, ${phoneModels.length - missing.length} already present`,
  );
  if (DRY_RUN) return;

  const product =
    existing ??
    (await prisma.product.create({
      data: {
        slug: SLUG,
        nameEn: 'Design Your Own Case',
        nameAr: 'صمم غطاءك الخاص',
        descriptionEn: 'Upload your own image and we print it on a case for your phone.',
        descriptionAr: 'ارفع صورتك ونطبعها على غطاء لهاتفك.',
        basePrice: PRICE,
        status: ProductStatus.DRAFT,
      },
    }));

  if (missing.length > 0) {
    await prisma.productVariant.createMany({
      data: missing.map((model) => ({
        productId: product.id,
        phoneModelId: model.id,
        caseTypeId: caseType.id,
        sku: `${SLUG}-${model.slug}-${caseType.slug}`.toUpperCase(),
        price: PRICE,
        isActive: true,
        isUnlimitedStock: true,
        isPersonalizable: true,
        customizationPrice: CUSTOMIZATION_PRICE,
      })),
      skipDuplicates: true,
    });
  }

  if (product.status !== ProductStatus.PUBLISHED) {
    await prisma.product.update({
      where: { id: product.id },
      data: { status: ProductStatus.PUBLISHED, publishedAt: product.publishedAt ?? new Date() },
    });
  }
  console.log(`Done: /products/${SLUG} is published with ${phoneModels.length} variants.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
