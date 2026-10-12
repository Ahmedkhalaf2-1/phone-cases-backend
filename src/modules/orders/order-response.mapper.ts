import { DEFAULT_LOCALE, Locale, pickLocalized } from '../../common/i18n/localized-field';
import { formatOrderNumber } from './order-pricing.util';
import type { OrderWithItems } from './orders.service';

/**
 * Guest-facing order view (tracking endpoint and the response to placing
 * an order). Localizes bilingual snapshot fields and presents a clean
 * shape - internal foreign keys (couponId, shippingRateId, cartId) are
 * deliberately omitted since they identify nothing the guest needs and
 * aren't meant to be a stable public contract.
 */
export function toGuestOrderView(order: OrderWithItems, locale: Locale = DEFAULT_LOCALE) {
  return {
    orderNumber: formatOrderNumber(order.sequenceNumber),
    trackingToken: order.trackingToken,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    // Minimal receipt status so the guest UI knows whether to prompt for a
    // replacement screenshot (POST /cart/receipts/replace) - never the
    // storageKey or any direct file reference; the image itself is only
    // ever reachable through GET /cart/receipts/:id/file, which re-checks
    // cart ownership independently of this response.
    receipts: order.receipts.map((receipt) => ({
      id: receipt.id,
      status: receipt.status,
      rejectionReason: receipt.rejectionReason,
      createdAt: receipt.createdAt,
    })),
    currency: order.currency,
    subtotal: order.subtotal,
    discountTotal: order.discountTotal,
    bundleDiscountTotal: order.bundleDiscountTotal,
    shippingTotal: order.shippingTotal,
    total: order.total,
    couponCode: order.couponCode,
    shippingRateName: order.shippingRateNameEn
      ? pickLocalized(order.shippingRateNameEn, order.shippingRateNameAr, locale)
      : null,
    shippingAddress: {
      fullName: order.customerFullName,
      phone: order.customerPhone,
      country: order.shippingCountry,
      city: order.shippingCity,
      addressLine1: order.shippingAddressLine1,
      addressLine2: order.shippingAddressLine2,
      postalCode: order.shippingPostalCode,
    },
    customerNote: order.customerNote,
    hasCustomDesign: order.items.some((item) => item.customDesign),
    items: order.items.map((item) => ({
      id: item.id,
      sku: item.variantSku,
      productName: pickLocalized(item.productNameEn, item.productNameAr, locale),
      phoneModelName: item.phoneModelNameEn
        ? pickLocalized(item.phoneModelNameEn, item.phoneModelNameAr, locale)
        : null,
      caseTypeName: item.caseTypeNameEn
        ? pickLocalized(item.caseTypeNameEn, item.caseTypeNameAr, locale)
        : null,
      note: item.note,
      hasCustomDesign: Boolean(item.customDesign),
      customizationPrice: item.customizationPrice,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      lineSubtotal: item.lineSubtotal,
      lineDiscount: item.lineDiscount,
      bundleDiscount: item.bundleDiscount,
      lineTotal: item.lineTotal,
    })),
    createdAt: order.createdAt,
  };
}

type OrderItemWithDesign = OrderWithItems['items'][number];

/**
 * Admin-facing view of a personalized line's design snapshot. Never
 * exposes storage keys; the files are only reachable through the
 * role-gated GET /admin/order-items/:orderItemId/custom-design/{original,
 * print-file,preview} endpoints, keyed by the order item's id.
 */
export function toAdminCustomDesignView(item: OrderItemWithDesign) {
  const design = item.customDesign;
  if (!design) return null;
  const base = `/api/v1/admin/order-items/${item.id}/custom-design`;
  return {
    id: design.id,
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
      mimeType: design.printFileMimeType,
      sizeBytes: design.printFileSizeBytes,
    },
    files: {
      original: `${base}/original`,
      print: `${base}/print-file`,
      preview: `${base}/preview`,
    },
    designCreatedAt: design.designCreatedAt,
  };
}

/** Admin order: raw order columns/relations, with each item's customDesign replaced by the safe view. */
export function toAdminOrderView(order: OrderWithItems) {
  return {
    ...order,
    items: order.items.map((item) => ({ ...item, customDesign: toAdminCustomDesignView(item) })),
  };
}
