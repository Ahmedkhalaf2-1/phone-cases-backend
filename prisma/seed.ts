/* eslint-disable no-console */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { CouponType, PrismaClient, ProductStatus, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const ownerEmail = (process.env.SEED_OWNER_ADMIN_EMAIL ?? 'owner@example.com').toLowerCase();
  const ownerPassword = process.env.SEED_OWNER_ADMIN_PASSWORD ?? 'change-me-now-12345';

  const existingStaffCount = await prisma.staffUser.count();
  if (existingStaffCount === 0) {
    const passwordHash = await bcrypt.hash(ownerPassword, 12);
    await prisma.staffUser.create({
      data: {
        email: ownerEmail,
        fullName: 'Owner Admin (demo)',
        role: StaffRole.OWNER_ADMIN,
        passwordHash,
      },
    });
    console.log(`Created bootstrap OWNER_ADMIN staff account: ${ownerEmail}`);
  } else {
    console.log('Staff users already exist, skipping bootstrap admin creation.');
  }

  const apple = await prisma.phoneBrand.upsert({
    where: { slug: 'apple' },
    update: {},
    create: { slug: 'apple', nameEn: 'Apple', nameAr: 'أبل', displayOrder: 1 },
  });
  const samsung = await prisma.phoneBrand.upsert({
    where: { slug: 'samsung' },
    update: {},
    create: { slug: 'samsung', nameEn: 'Samsung', nameAr: 'سامسونج', displayOrder: 2 },
  });

  const iphone15 = await prisma.phoneModel.upsert({
    where: { slug: 'iphone-15' },
    update: {},
    create: {
      slug: 'iphone-15',
      nameEn: 'iPhone 15',
      nameAr: 'آيفون 15',
      brandId: apple.id,
      releaseYear: 2023,
      displayOrder: 1,
    },
  });
  const iphone15Pro = await prisma.phoneModel.upsert({
    where: { slug: 'iphone-15-pro' },
    update: {},
    create: {
      slug: 'iphone-15-pro',
      nameEn: 'iPhone 15 Pro',
      nameAr: 'آيفون 15 برو',
      brandId: apple.id,
      releaseYear: 2023,
      displayOrder: 2,
    },
  });
  const galaxyS24 = await prisma.phoneModel.upsert({
    where: { slug: 'galaxy-s24' },
    update: {},
    create: {
      slug: 'galaxy-s24',
      nameEn: 'Galaxy S24',
      nameAr: 'جالاكسي إس 24',
      brandId: samsung.id,
      releaseYear: 2024,
      displayOrder: 1,
    },
  });

  const shockResistant = await prisma.caseType.upsert({
    where: { slug: 'shock-resistant' },
    update: {},
    create: {
      slug: 'shock-resistant',
      nameEn: 'Shock-Resistant',
      nameAr: 'مقاوم للصدمات',
      descriptionEn: 'Reinforced corners absorb drops and impacts.',
      descriptionAr: 'زوايا مقواة تمتص الصدمات والسقوط.',
      displayOrder: 1,
    },
  });
  const slim = await prisma.caseType.upsert({
    where: { slug: 'slim' },
    update: {},
    create: {
      slug: 'slim',
      nameEn: 'Slim',
      nameAr: 'رفيع',
      descriptionEn: 'A thin, lightweight fit that keeps your phone pocketable.',
      descriptionAr: 'تصميم رفيع وخفيف الوزن يحافظ على سهولة حمل الهاتف.',
      displayOrder: 2,
    },
  });

  const newArrivals = await prisma.collection.upsert({
    where: { slug: 'new-arrivals' },
    update: {},
    create: {
      slug: 'new-arrivals',
      nameEn: 'New Arrivals',
      nameAr: 'وصل حديثًا',
      descriptionEn: 'The latest designs added to the store.',
      descriptionAr: 'أحدث التصاميم المضافة للمتجر.',
      displayOrder: 1,
    },
  });

  const spaceProduct = await prisma.product.upsert({
    where: { slug: 'space' },
    update: {},
    create: {
      slug: 'space',
      nameEn: 'Space',
      nameAr: 'الفضاء',
      descriptionEn: 'A deep-space artwork design available for multiple phone models.',
      descriptionAr: 'تصميم فني مستوحى من الفضاء متوفر لعدة موديلات هواتف.',
      status: ProductStatus.PUBLISHED,
      publishedAt: new Date(),
      currency: process.env.DEFAULT_CURRENCY ?? 'EGP',
    },
  });

  await prisma.productCollection.upsert({
    where: { productId_collectionId: { productId: spaceProduct.id, collectionId: newArrivals.id } },
    update: {},
    create: { productId: spaceProduct.id, collectionId: newArrivals.id },
  });

  const variantSeeds: Array<{
    sku: string;
    phoneModelId: string;
    caseTypeId: string;
    price: number;
    compareAtPrice?: number;
  }> = [
    { sku: 'SPACE-IP15-SHOCK', phoneModelId: iphone15.id, caseTypeId: shockResistant.id, price: 45000 },
    {
      sku: 'SPACE-IP15PRO-SHOCK',
      phoneModelId: iphone15Pro.id,
      caseTypeId: shockResistant.id,
      price: 48000,
      compareAtPrice: 52000,
    },
    { sku: 'SPACE-IP15-SLIM', phoneModelId: iphone15.id, caseTypeId: slim.id, price: 35000 },
    { sku: 'SPACE-S24-SHOCK', phoneModelId: galaxyS24.id, caseTypeId: shockResistant.id, price: 45000 },
  ];

  for (const seedVariant of variantSeeds) {
    await prisma.productVariant.upsert({
      where: { sku: seedVariant.sku },
      update: {},
      // These demo variants have no StockItem linked - isUnlimitedStock:
      // true is the explicit administrative choice required for them to
      // show as purchasable (see docs/BUSINESS_RULES.md); it is never
      // assumed just because stockItemId is absent.
      create: { ...seedVariant, productId: spaceProduct.id, isUnlimitedStock: true },
    });
  }

  const draftProduct = await prisma.product.upsert({
    where: { slug: 'nebula-draft' },
    update: {},
    create: {
      slug: 'nebula-draft',
      nameEn: 'Nebula (draft)',
      nameAr: 'سديم (مسودة)',
      descriptionEn: 'A work-in-progress design not yet visible to shoppers.',
      descriptionAr: 'تصميم قيد الإعداد وغير مرئي للعملاء بعد.',
      status: ProductStatus.DRAFT,
      currency: process.env.DEFAULT_CURRENCY ?? 'EGP',
    },
  });
  await prisma.productVariant.upsert({
    where: { sku: 'NEBULA-IP15-SLIM' },
    update: {},
    create: { sku: 'NEBULA-IP15-SLIM', productId: draftProduct.id, phoneModelId: iphone15.id, caseTypeId: slim.id, price: 35000 },
  });

  // --- Shipping (demo data only - see docs/DECISIONS.md. These are NOT
  // real prices or delivery promises; the business must set real rates
  // through the admin API before going live). ---
  const egyptZone = await prisma.shippingZone.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      nameEn: 'Egypt (demo)',
      nameAr: 'مصر (تجريبي)',
      countries: ['EG'],
      displayOrder: 1,
    },
  });
  await prisma.shippingRate.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      zoneId: egyptZone.id,
      nameEn: 'Standard delivery (demo)',
      nameAr: 'توصيل عادي (تجريبي)',
      price: 5000,
      freeShippingThreshold: 150000,
      estimatedDaysMin: 2,
      estimatedDaysMax: 5,
      displayOrder: 1,
    },
  });
  await prisma.shippingRate.upsert({
    where: { id: '00000000-0000-0000-0000-000000000003' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000003',
      zoneId: egyptZone.id,
      nameEn: 'Express delivery (demo)',
      nameAr: 'توصيل سريع (تجريبي)',
      price: 12000,
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
      displayOrder: 2,
    },
  });

  // --- Demo coupon ---
  await prisma.coupon.upsert({
    where: { code: 'WELCOME10' },
    update: {},
    create: {
      code: 'WELCOME10',
      type: CouponType.PERCENTAGE,
      value: 10,
      usageLimit: 100,
    },
  });

  console.log('Seed data applied.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
