import type { CustomDesign } from '@prisma/client';

/**
 * Guest-facing view of an uploaded design - deliberately never includes a
 * storageKey or any direct file path. The actual image bytes are only ever
 * reachable through GET /cart/custom-designs/:id/{original,preview}, which
 * re-checks cart ownership independently of this response (same pattern as
 * PaymentReceipt - see order-response.mapper.ts).
 */
export function toCustomDesignView(design: CustomDesign) {
  return {
    id: design.id,
    variantId: design.variantId,
    fitMode: design.fitMode,
    original: {
      mimeType: design.originalMimeType,
      sizeBytes: design.originalSizeBytes,
      width: design.originalWidth,
      height: design.originalHeight,
    },
    print: {
      widthPx: design.printWidthPx,
      heightPx: design.printHeightPx,
      dpi: design.printDpi,
      safeMarginPx: design.printSafeMarginPx,
      outputFormat: design.printOutputFormat,
      outputQuality: design.printOutputQuality,
    },
    createdAt: design.createdAt,
  };
}
