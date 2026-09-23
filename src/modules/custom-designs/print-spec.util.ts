import { PrintOutputFormat } from '@prisma/client';

export interface PrintSpec {
  widthPx: number;
  heightPx: number;
  dpi: number;
  safeMarginPx: number | null;
  outputFormat: PrintOutputFormat;
  outputQuality: number;
}

/**
 * Sensible out-of-the-box print canvas for a personalizable variant with no
 * PrintSpecification row of its own - roughly a typical phone case's
 * printable area (4in x 8in) at the requested-by-default 300 DPI. Lets the
 * feature work immediately with zero admin configuration; a real,
 * model-specific override is just a PrintSpecification row away (see
 * VariantsService.upsertPrintSpec) and never requires a code change. See
 * docs/DECISIONS.md.
 */
export const DEFAULT_PRINT_SPEC: PrintSpec = {
  widthPx: 1200,
  heightPx: 2400,
  dpi: 300,
  safeMarginPx: 40,
  outputFormat: PrintOutputFormat.JPEG,
  outputQuality: 92,
};

export function resolvePrintSpec(
  override: {
    widthPx: number;
    heightPx: number;
    dpi: number;
    safeMarginPx: number | null;
    outputFormat: PrintOutputFormat;
    outputQuality: number;
  } | null,
): PrintSpec {
  if (!override) return DEFAULT_PRINT_SPEC;
  return {
    widthPx: override.widthPx,
    heightPx: override.heightPx,
    dpi: override.dpi,
    safeMarginPx: override.safeMarginPx,
    outputFormat: override.outputFormat,
    outputQuality: override.outputQuality,
  };
}
