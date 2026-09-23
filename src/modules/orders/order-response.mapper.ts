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
