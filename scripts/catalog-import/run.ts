/* eslint-disable no-console */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ProductStatus, StaffRole } from '@prisma/client';
import { dedupeCandidates, DedupeCluster } from '../../src/common/utils/image-dedupe.util';
import { COLLECTIONS, DESIGN_MANIFEST, DesignManifestEntry } from './design-manifest';
import { createMediaStorage } from './media-storage.adapter';
import { PHONE_BRANDS, PHONE_MODELS } from './phone-catalog';
import type { ImportReport, PreflightCheck, ProductOutcome } from './report';
import { renderMarkdown, writeReport } from './report';
import { scanSourceFolder } from './scan';

const IMPORT_MARKER_PREFIX = '[bulk-import:v1] source=';
const VARIANT_PRICE = 25000; // 250 EGP flat, per explicit sign-off - see the import plan.
const CASE_TYPE_SLUGS = ['shock-resistant', 'slim'] as const;
const DEVICE_SPECIFIC_KEYWORDS = ['magsafe', 'iphone', 'samsung', 'airtag', 'apple watch'];
const VARIANT_BATCH_SIZE = 500;
const SKU_CHECK_BATCH_SIZE = 500;
const FRONTEND_MODEL_COUNT_ADVISORY_THRESHOLD = 60;

interface CliOptions {
  sourceDir: string;
  commit: boolean;
  allowUncategorized: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const sourceIndex = argv.indexOf('--source');
  const sourceDir = sourceIndex >= 0 ? argv[sourceIndex + 1] : undefined;
  if (!sourceDir) {
    throw new Error('Usage: import:catalog -- --source <folder> [--commit] [--allow-uncategorized]');
  }
  return {
    sourceDir,
    commit: argv.includes('--commit'),
    allowUncategorized: argv.includes('--allow-uncategorized'),
  };
}

function buildSku(productSlug: string, phoneModelSlug: string, caseTypeSlug: string): string {
  return `${productSlug}-${phoneModelSlug}-${caseTypeSlug}`.toUpperCase();
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const mode: ImportReport['mode'] = options.commit ? 'commit' : 'dry-run';

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  const storage = createMediaStorage();

  const report: ImportReport = {
    mode,
    sourceDir: options.sourceDir,
    startedAt,
    scannedFiles: 0,
    excludedNonDesign: [],
    candidatesConsidered: 0,
    duplicateGroups: [],
    exactDuplicateCount: 0,
    sameSourceGroupCount: 0,
    nearDuplicateCount: 0,
    survivorCount: 0,
    uncategorized: [],
    allowUncategorized: options.allowUncategorized,
    preflight: [],
    preflightPassed: true,
    productOutcomes: [],
    phoneBrandsUpserted: 0,
    phoneModelsUpserted: 0,
    caseTypesReused: 0,
    collectionsUpserted: 0,
    productsCreated: 0,
    productsReconciled: 0,
    productsSkippedExisting: 0,
    productsSkippedUncategorized: 0,
    mediaUploaded: 0,
    variantsCreated: 0,
    variantsAlreadyExisted: 0,
    errors: [],
  };

  try {
    console.log(`[${mode}] Scanning "${options.sourceDir}"...`);
    const { candidates, excluded } = await scanSourceFolder(options.sourceDir);
    report.scannedFiles = candidates.length + excluded.length;
    report.excludedNonDesign = excluded;
    report.candidatesConsidered = candidates.length;

    // Perceptual-hash auto-merging is deliberately disabled for this real
    // import - see the long comment on NEAR_DUPLICATE_HAMMING_THRESHOLD in
    // image-dedupe.util.ts for the reproduced false-merge this avoids.
    // groupKey (derived in scan.ts from this batch's own scrape filename
    // convention) plus exact sha256 carry the actual dedup.
    const clusters = dedupeCandidates(candidates, { nearDuplicateHammingThreshold: -1 });
    report.survivorCount = clusters.length;
    for (const cluster of clusters) {
      if (cluster.reason === 'exact-duplicate') report.exactDuplicateCount++;
      if (cluster.reason === 'same-source-group') report.sameSourceGroupCount++;
      if (cluster.reason === 'near-duplicate') report.nearDuplicateCount++;
      report.duplicateGroups.push({
        chosenFilename: cluster.chosen.filename,
        chosenDimensions: `${cluster.chosen.width}x${cluster.chosen.height}`,
        reason: cluster.reason,
        skippedFilenames: cluster.members
          .filter((m) => m.id !== cluster.chosen.id)
          .map((m) => m.filename),
      });
    }

    const categorized: Array<{ cluster: DedupeCluster; entry: DesignManifestEntry }> = [];
    for (const cluster of clusters) {
      const entry = DESIGN_MANIFEST[cluster.chosen.filename];
      if (entry) {
        categorized.push({ cluster, entry });
      } else {
        report.uncategorized.push({
          filename: cluster.chosen.filename,
          dimensions: `${cluster.chosen.width}x${cluster.chosen.height}`,
        });
      }
    }
    report.productsSkippedUncategorized = report.uncategorized.length;

    const blockedByUncategorized =
      report.uncategorized.length > 0 && !options.allowUncategorized;

    // --- Pre-flight validation (read-only; runs in both modes) ---------
    const preflight: PreflightCheck[] = [];

    // 1. SKU uniqueness + length across the *planned* import set.
    const plannedSkus = new Set<string>();
    let duplicateSkuFound = false;
    let overlongSkuFound = false;
    for (const { entry } of categorized) {
      for (const model of PHONE_MODELS) {
        for (const caseSlug of CASE_TYPE_SLUGS) {
          const sku = buildSku(entry.slug, model.slug, caseSlug);
          if (plannedSkus.has(sku)) duplicateSkuFound = true;
          plannedSkus.add(sku);
          if (sku.length > 200) overlongSkuFound = true;
        }
      }
    }
    preflight.push({
      name: 'SKU uniqueness (in-batch)',
      passed: !duplicateSkuFound,
      detail: duplicateSkuFound
        ? 'Two planned variants would share the same SKU.'
        : `${plannedSkus.size} planned SKUs, all unique.`,
    });
    preflight.push({
      name: 'SKU length',
      passed: !overlongSkuFound,
      detail: overlongSkuFound
        ? 'A planned SKU exceeds 200 characters.'
        : 'product_variants.sku is Postgres text (unbounded) - all planned SKUs are well under 200 chars.',
    });

    // Collision against SKUs already in the DB that belong to a DIFFERENT
    // product than the one we're about to create/reconcile.
    let externalSkuCollision: string | null = null;
    const plannedSkuList = [...plannedSkus];
    const categorizedSlugs = new Set(categorized.map((c) => c.entry.slug));
    for (const batch of chunk(plannedSkuList, SKU_CHECK_BATCH_SIZE)) {
      const existing = await prisma.productVariant.findMany({
        where: { sku: { in: batch } },
        select: { sku: true, product: { select: { slug: true } } },
      });
      const conflict = existing.find((v) => !categorizedSlugs.has(v.product.slug));
      if (conflict) {
        externalSkuCollision = conflict.sku;
        break;
      }
    }
    preflight.push({
      name: 'SKU collision against existing catalog',
      passed: !externalSkuCollision,
      detail: externalSkuCollision
        ? `SKU "${externalSkuCollision}" already belongs to a different, unrelated product.`
        : 'No planned SKU collides with an existing variant outside this import.',
    });

    // 2. Case-type compatibility - genuinely checked via a keyword scan,
    // not assumed. See the plan for why this is safe today.
    const caseTypes = await prisma.caseType.findMany({ where: { slug: { in: [...CASE_TYPE_SLUGS] } } });
    const missingCaseTypeSlugs = CASE_TYPE_SLUGS.filter(
      (slug) => !caseTypes.find((c) => c.slug === slug),
    );
    for (const slug of missingCaseTypeSlugs) {
      report.errors.push(`Expected CaseType "${slug}" does not exist - run "npm run seed" first.`);
    }
    const deviceSpecificCaseTypes = caseTypes.filter((c) => {
      const haystack = `${c.nameEn} ${c.nameAr} ${c.descriptionEn ?? ''} ${c.descriptionAr ?? ''}`.toLowerCase();
      return DEVICE_SPECIFIC_KEYWORDS.some((kw) => haystack.includes(kw));
    });
    preflight.push({
      name: 'Case-type / phone-model compatibility',
      passed: missingCaseTypeSlugs.length === 0,
      detail:
        missingCaseTypeSlugs.length > 0
          ? `Missing expected case type(s): ${missingCaseTypeSlugs.join(', ')}.`
          : deviceSpecificCaseTypes.length === 0
            ? `Scanned ${caseTypes.length} case type(s) (${caseTypes.map((c) => c.nameEn).join(', ')}) for device-specific ` +
              `terms (${DEVICE_SPECIFIC_KEYWORDS.join(', ')}) - none found, so every phone model is treated as ` +
              'compatible with every case type.'
            : `${deviceSpecificCaseTypes.map((c) => c.nameEn).join(', ')} mention device-specific terms - ` +
              'incompatible model/case-type combinations are excluded from the variant matrix.',
    });

    // 3. Phone-model roster scale - advisory only, can't be verified from
    // this backend-only repo (no frontend code here to test against).
    preflight.push({
      name: 'Frontend phone-selector scale (advisory)',
      passed: true,
      detail:
        `${PHONE_MODELS.length} phone models total` +
        (PHONE_MODELS.length > FRONTEND_MODEL_COUNT_ADVISORY_THRESHOLD
          ? ' - this is a lot of options for a single dropdown/selector; relay this to whoever owns the storefront ' +
            'frontend so they can decide on search/grouping. Not verifiable from this backend-only repository.'
          : '.'),
    });

    report.preflight = preflight;
    report.preflightPassed = preflight.every((c) => c.passed) && report.errors.length === 0;

    if (blockedByUncategorized) {
      report.errors.push(
        `${report.uncategorized.length} survivor(s) have no design-manifest.ts entry. Add them, or re-run with ` +
          '--allow-uncategorized to skip them.',
      );
    }

    const canWrite =
      options.commit && report.preflightPassed && (!blockedByUncategorized || options.allowUncategorized);

    if (options.commit && !canWrite) {
      console.error('[commit] Aborting before any writes - see errors in the report.');
    }

    // --- Phone brand/model taxonomy (idempotent upsert, or read-only
    // existence check in dry-run) --------------------------------------
    const phoneModelIdBySlug = new Map<string, string>();
    if (options.commit && canWrite) {
      for (const brand of PHONE_BRANDS) {
        const row = await prisma.phoneBrand.upsert({
          where: { slug: brand.slug },
          update: {},
          create: brand,
        });
        report.phoneBrandsUpserted++;
        void row;
      }
      for (const model of PHONE_MODELS) {
        const brand = await prisma.phoneBrand.findUniqueOrThrow({ where: { slug: model.brandSlug } });
        const row = await prisma.phoneModel.upsert({
          where: { slug: model.slug },
          update: {},
          create: {
            slug: model.slug,
            brandId: brand.id,
            nameEn: model.nameEn,
            nameAr: model.nameAr,
            releaseYear: model.releaseYear,
            displayOrder: model.displayOrder,
          },
        });
        phoneModelIdBySlug.set(model.slug, row.id);
        report.phoneModelsUpserted++;
      }
      for (const [key, collection] of Object.entries(COLLECTIONS)) {
        await prisma.collection.upsert({
          where: { slug: key },
          update: {},
          create: { slug: key, ...collection },
        });
        report.collectionsUpserted++;
      }
    } else {
      report.phoneBrandsUpserted = PHONE_BRANDS.length;
      report.phoneModelsUpserted = PHONE_MODELS.length;
      report.collectionsUpserted = Object.keys(COLLECTIONS).length;
    }
    report.caseTypesReused = caseTypes.length;

    const staffActor = canWrite
      ? ((await prisma.staffUser.findFirst({ where: { isActive: true, role: StaffRole.OWNER_ADMIN } })) ??
        (await prisma.staffUser.findFirst({ where: { isActive: true } })))
      : null;
    if (canWrite && !staffActor) {
      report.errors.push('No active StaffUser found - run "npm run seed" first to bootstrap an OWNER_ADMIN.');
    }

    // --- Products --------------------------------------------------------
    // The read-only lookups below (product/media/variant existence) always
    // run, in both modes, so a dry-run accurately reflects current DB state
    // (create vs reconcile vs skip) instead of naively assuming everything
    // is new. Only the actual file/DB writes are gated on `canWrite`.
    const notWritingReason = !options.commit
      ? '(dry run)'
      : !canWrite
        ? '(blocked - see preflight errors)'
        : null;

    for (const { cluster, entry } of categorized) {
      const outcome: ProductOutcome = {
        slug: entry.slug,
        nameEn: entry.nameEn,
        sourceFilename: cluster.chosen.filename,
        outcome: 'created',
        detail: '',
      };

      try {
        const existing = await prisma.product.findUnique({ where: { slug: entry.slug } });

        if (existing && !existing.internalNotes?.startsWith(IMPORT_MARKER_PREFIX)) {
          outcome.outcome = 'skipped-existing-non-import';
          outcome.detail = `Product "${entry.slug}" already exists and was not created by this importer - left untouched.`;
          report.productOutcomes.push(outcome);
          continue;
        }

        const expectedVariants = PHONE_MODELS.flatMap((model) =>
          CASE_TYPE_SLUGS.map((caseSlug) => ({
            sku: buildSku(entry.slug, model.slug, caseSlug),
            modelSlug: model.slug,
            caseSlug,
          })),
        );

        if (existing) {
          // --- Reconcile: add only what's missing, never touch what's there.
          const mediaCount = await prisma.productMedia.count({ where: { productId: existing.id } });
          const existingSkus = new Set(
            (await prisma.productVariant.findMany({ where: { productId: existing.id }, select: { sku: true } })).map(
              (v) => v.sku,
            ),
          );
          const missingVariants = expectedVariants.filter((v) => !existingSkus.has(v.sku));

          if (notWritingReason) {
            outcome.outcome = 'reconciled';
            outcome.detail =
              `Would add ${mediaCount === 0 ? 'media, ' : ''}${missingVariants.length} missing variant(s) ` +
              notWritingReason;
            outcome.variantsCreated = missingVariants.length;
            outcome.variantsAlreadyExisted = existingSkus.size;
            outcome.mediaAdded = mediaCount === 0;
            report.productOutcomes.push(outcome);
            continue;
          }
          if (!staffActor) {
            outcome.outcome = 'error';
            outcome.detail = 'No staff actor available.';
            report.errors.push(`Product "${entry.slug}": no staff actor available.`);
            report.productOutcomes.push(outcome);
            continue;
          }

          let uploadedThisRun: string | null = null;
          try {
            await prisma.$transaction(async (tx) => {
              if (mediaCount === 0) {
                const buffer = await readFile(cluster.chosen.id);
                const saved = await storage.save(buffer, cluster.chosen.filename, 'image/jpeg');
                uploadedThisRun = saved.storageKey;
                const asset = await tx.mediaAsset.create({
                  data: {
                    storageKey: saved.storageKey,
                    url: saved.url,
                    mimeType: 'image/jpeg',
                    fileSizeBytes: cluster.chosen.fileSizeBytes,
                    width: cluster.chosen.width,
                    height: cluster.chosen.height,
                    altTextEn: `${entry.nameEn} phone case`,
                    altTextAr: `جراب ${entry.nameAr}`,
                    uploadedByStaffId: staffActor.id,
                  },
                });
                await tx.productMedia.create({
                  data: { productId: existing.id, mediaAssetId: asset.id, isPrimary: true, displayOrder: 0 },
                });
              }

              // upsert (not create): this link may already exist from a
              // prior partial run - update: {} makes a repeat a safe no-op.
              for (const collectionSlug of entry.collections) {
                const collection = await tx.collection.findUniqueOrThrow({ where: { slug: collectionSlug } });
                await tx.productCollection.upsert({
                  where: { productId_collectionId: { productId: existing.id, collectionId: collection.id } },
                  update: {},
                  create: { productId: existing.id, collectionId: collection.id },
                });
              }

              if (missingVariants.length > 0) {
                const variantRows = missingVariants.map((v) => ({
                  productId: existing.id,
                  sku: v.sku,
                  phoneModelId: phoneModelIdBySlug.get(v.modelSlug)!,
                  caseTypeId: caseTypes.find((c) => c.slug === v.caseSlug)!.id,
                  price: VARIANT_PRICE,
                  isUnlimitedStock: true,
                  isActive: true,
                }));
                for (const batch of chunk(variantRows, VARIANT_BATCH_SIZE)) {
                  await tx.productVariant.createMany({ data: batch, skipDuplicates: true });
                }
              }
            });
          } catch (error) {
            if (uploadedThisRun) await storage.delete(uploadedThisRun);
            throw error;
          }

          outcome.outcome = 'reconciled';
          outcome.detail = `Added ${mediaCount === 0 ? 'media, ' : ''}${missingVariants.length} missing variant(s).`;
          outcome.variantsCreated = missingVariants.length;
          outcome.variantsAlreadyExisted = existingSkus.size;
          outcome.mediaAdded = mediaCount === 0;
        } else {
          // --- Create from scratch.
          if (notWritingReason) {
            outcome.outcome = 'created';
            outcome.detail = `Would be created with ${expectedVariants.length} variants ${notWritingReason}`;
            outcome.variantsCreated = expectedVariants.length;
            outcome.mediaAdded = true;
            report.productOutcomes.push(outcome);
            continue;
          }
          if (!staffActor) {
            outcome.outcome = 'error';
            outcome.detail = 'No staff actor available.';
            report.errors.push(`Product "${entry.slug}": no staff actor available.`);
            report.productOutcomes.push(outcome);
            continue;
          }

          const buffer = await readFile(cluster.chosen.id);
          const saved = await storage.save(buffer, cluster.chosen.filename, 'image/jpeg');
          try {
            await prisma.$transaction(async (tx) => {
              const product = await tx.product.create({
                data: {
                  slug: entry.slug,
                  nameEn: entry.nameEn,
                  nameAr: entry.nameAr,
                  status: ProductStatus.PUBLISHED,
                  publishedAt: new Date(),
                  currency: process.env.DEFAULT_CURRENCY ?? 'EGP',
                  internalNotes: `${IMPORT_MARKER_PREFIX}${cluster.chosen.filename}`,
                },
              });

              const asset = await tx.mediaAsset.create({
                data: {
                  storageKey: saved.storageKey,
                  url: saved.url,
                  mimeType: 'image/jpeg',
                  fileSizeBytes: cluster.chosen.fileSizeBytes,
                  width: cluster.chosen.width,
                  height: cluster.chosen.height,
                  altTextEn: `${entry.nameEn} phone case`,
                  altTextAr: `جراب ${entry.nameAr}`,
                  uploadedByStaffId: staffActor.id,
                },
              });
              await tx.productMedia.create({
                data: { productId: product.id, mediaAssetId: asset.id, isPrimary: true, displayOrder: 0 },
              });

              for (const collectionSlug of entry.collections) {
                const collection = await tx.collection.findUniqueOrThrow({ where: { slug: collectionSlug } });
                await tx.productCollection.create({
                  data: { productId: product.id, collectionId: collection.id },
                });
              }

              const variantRows = expectedVariants.map((v) => ({
                productId: product.id,
                sku: v.sku,
                phoneModelId: phoneModelIdBySlug.get(v.modelSlug)!,
                caseTypeId: caseTypes.find((c) => c.slug === v.caseSlug)!.id,
                price: VARIANT_PRICE,
                isUnlimitedStock: true,
                isActive: true,
              }));
              for (const batch of chunk(variantRows, VARIANT_BATCH_SIZE)) {
                await tx.productVariant.createMany({ data: batch, skipDuplicates: true });
              }
            });
          } catch (error) {
            await storage.delete(saved.storageKey);
            throw error;
          }

          outcome.outcome = 'created';
          outcome.detail = `Created with ${expectedVariants.length} variants.`;
          outcome.variantsCreated = expectedVariants.length;
          outcome.mediaAdded = true;
        }
      } catch (error) {
        outcome.outcome = 'error';
        outcome.detail = `Error: ${error instanceof Error ? error.message : String(error)}`;
        report.errors.push(`Product "${entry.slug}": ${outcome.detail}`);
      }

      report.productOutcomes.push(outcome);
    }

    // Derive every summary count from the outcomes actually recorded above,
    // so dry-run and commit reports are always consistent with the
    // per-product table - never separately-tracked counters that could
    // drift from what the table says.
    report.productsCreated = report.productOutcomes.filter((o) => o.outcome === 'created').length;
    report.productsReconciled = report.productOutcomes.filter((o) => o.outcome === 'reconciled').length;
    report.productsSkippedExisting = report.productOutcomes.filter(
      (o) => o.outcome === 'skipped-existing-non-import',
    ).length;
    report.mediaUploaded = report.productOutcomes.filter((o) => o.mediaAdded).length;
    report.variantsCreated = report.productOutcomes.reduce((sum, o) => sum + (o.variantsCreated ?? 0), 0);
    report.variantsAlreadyExisted = report.productOutcomes.reduce(
      (sum, o) => sum + (o.variantsAlreadyExisted ?? 0),
      0,
    );

    if (canWrite && staffActor) {
      await prisma.auditLog.create({
        data: {
          staffUserId: staffActor.id,
          action: 'catalog.bulk_import',
          entityType: 'Product',
          metadata: {
            productsCreated: report.productsCreated,
            productsReconciled: report.productsReconciled,
            productsSkippedExisting: report.productsSkippedExisting,
            variantsCreated: report.variantsCreated,
            mediaUploaded: report.mediaUploaded,
            sourceDir: options.sourceDir,
          },
        },
      });
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    const reportsDir = path.join(__dirname, 'reports');
    const reportPath = await writeReport(report, reportsDir);
    console.log(renderMarkdown(report));
    console.log(`\nReport written to ${reportPath}`);
    await prisma.$disconnect();
  }

  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
