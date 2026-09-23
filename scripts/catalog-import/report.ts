import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface DuplicateGroupReport {
  chosenFilename: string;
  chosenDimensions: string;
  reason: string;
  skippedFilenames: string[];
}

export interface ProductOutcome {
  slug: string;
  nameEn: string;
  sourceFilename: string;
  outcome: 'created' | 'reconciled' | 'skipped-existing-non-import' | 'skipped-uncategorized' | 'error';
  detail: string;
  variantsCreated?: number;
  variantsAlreadyExisted?: number;
  /** Whether a MediaAsset was (or, in dry-run, would be) added for this product. */
  mediaAdded?: boolean;
}

export interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ImportReport {
  mode: 'dry-run' | 'commit';
  sourceDir: string;
  startedAt: string;

  scannedFiles: number;
  excludedNonDesign: Array<{ filename: string; reason: string }>;
  candidatesConsidered: number;

  duplicateGroups: DuplicateGroupReport[];
  exactDuplicateCount: number;
  sameSourceGroupCount: number;
  nearDuplicateCount: number;
  survivorCount: number;

  uncategorized: Array<{ filename: string; dimensions: string }>;
  allowUncategorized: boolean;

  preflight: PreflightCheck[];
  preflightPassed: boolean;

  productOutcomes: ProductOutcome[];

  phoneBrandsUpserted: number;
  phoneModelsUpserted: number;
  caseTypesReused: number;
  collectionsUpserted: number;

  productsCreated: number;
  productsReconciled: number;
  productsSkippedExisting: number;
  productsSkippedUncategorized: number;
  mediaUploaded: number;
  variantsCreated: number;
  variantsAlreadyExisted: number;

  errors: string[];
}

export function renderMarkdown(report: ImportReport): string {
  const lines: string[] = [];
  const push = (s = ''): void => void lines.push(s);

  push(`# Catalog import report (${report.mode})`);
  push();
  push(`- Source folder: \`${report.sourceDir}\``);
  push(`- Started at: ${report.startedAt}`);
  push();

  push('## Scan');
  push(`- Files scanned: ${report.scannedFiles}`);
  push(`- Excluded (not a product design): ${report.excludedNonDesign.length}`);
  push(`- Candidates considered for dedup: ${report.candidatesConsidered}`);
  push();
  if (report.excludedNonDesign.length > 0) {
    push('<details><summary>Excluded files and why</summary>\n');
    const byReason = new Map<string, number>();
    for (const e of report.excludedNonDesign) {
      byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) {
      push(`- ${count}x - ${reason}`);
    }
    push('\n</details>\n');
  }

  push('## Deduplication');
  push(`- Unique designs (survivors): ${report.survivorCount}`);
  push(`- Exact-duplicate groups (byte-identical): ${report.exactDuplicateCount}`);
  push(`- Same-source groups (same design, different scrape resolution): ${report.sameSourceGroupCount}`);
  push(`- Near-duplicate groups (perceptual match, no shared source hint): ${report.nearDuplicateCount}`);
  push();
  push('<details><summary>Every duplicate group and the chosen source image</summary>\n');
  push('| Chosen file | Dimensions | Reason | Skipped duplicates |');
  push('|---|---|---|---|');
  for (const g of report.duplicateGroups) {
    push(
      `| ${g.chosenFilename} | ${g.chosenDimensions} | ${g.reason} | ${g.skippedFilenames.length} |`,
    );
  }
  push('\n</details>\n');

  push('## Categorization');
  push(`- Categorized (in the manifest): ${report.survivorCount - report.uncategorized.length}`);
  push(`- Uncategorized: ${report.uncategorized.length}`);
  if (report.uncategorized.length > 0) {
    push();
    push(
      report.allowUncategorized
        ? '_--allow-uncategorized was passed: these are skipped, not imported._'
        : '_Blocking --commit until these are added to design-manifest.ts, or re-run with --allow-uncategorized to skip them._',
    );
    push();
    for (const u of report.uncategorized) {
      push(`- ${u.filename} (${u.dimensions})`);
    }
  }
  push();

  push('## Pre-flight validation');
  push(`- Overall: ${report.preflightPassed ? 'PASSED' : 'FAILED'}`);
  for (const c of report.preflight) {
    push(`- [${c.passed ? 'x' : ' '}] ${c.name} - ${c.detail}`);
  }
  push();

  push('## Products');
  push('| Product | Outcome | Detail | Variants created | Variants already existed |');
  push('|---|---|---|---|---|');
  for (const p of report.productOutcomes) {
    push(
      `| ${p.nameEn} (${p.slug}) | ${p.outcome} | ${p.detail} | ${p.variantsCreated ?? '-'} | ${p.variantsAlreadyExisted ?? '-'} |`,
    );
  }
  push();

  push('## Summary counts');
  push(`- Phone brands upserted: ${report.phoneBrandsUpserted}`);
  push(`- Phone models upserted: ${report.phoneModelsUpserted}`);
  push(`- Case types reused: ${report.caseTypesReused}`);
  push(`- Collections upserted: ${report.collectionsUpserted}`);
  push(`- Products created: ${report.productsCreated}`);
  push(`- Products reconciled (missing pieces added): ${report.productsReconciled}`);
  push(`- Products skipped (existing, not import-owned): ${report.productsSkippedExisting}`);
  push(`- Products skipped (uncategorized): ${report.productsSkippedUncategorized}`);
  push(`- Media uploaded: ${report.mediaUploaded}`);
  push(`- Variants created: ${report.variantsCreated}`);
  push(`- Variants already existed: ${report.variantsAlreadyExisted}`);
  push();

  if (report.errors.length > 0) {
    push('## Errors');
    for (const e of report.errors) push(`- ${e}`);
    push();
  }

  return lines.join('\n');
}

export async function writeReport(report: ImportReport, reportsDir: string): Promise<string> {
  await mkdir(reportsDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const base = `${stamp}-${report.mode}`;
  const mdPath = path.join(reportsDir, `${base}.md`);
  const jsonPath = path.join(reportsDir, `${base}.json`);
  await writeFile(mdPath, renderMarkdown(report), 'utf8');
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  return mdPath;
}
