import { BadRequestException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CartStatus,
  FulfillmentStatus,
  OrderPaymentMethod,
  PaymentReceipt,
  PaymentStatus,
  Prisma,
  ReceiptStatus,
} from '@prisma/client';
import sharp from 'sharp';
import { AppException, ResourceNotFoundException } from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { RECEIPT_STORAGE, ReceiptStorageDriver } from './receipt-storage/receipt-storage.interface';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface DecodedFile {
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
}

@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorageDriver,
  ) {}

  /**
   * Validates a multer file's *actual* content (never trusting the
   * declared Content-Type/extension alone) - decodes it with sharp to
   * confirm it is really a JPEG/PNG/WebP image and to read its real
   * dimensions, and enforces the configurable size limit. Shared by both
   * the pre-order upload and the post-rejection replacement upload.
   */
  private async decodeAndValidate(file: Express.Multer.File): Promise<DecodedFile> {
    const maxSize = this.configService.getOrThrow<number>('RECEIPT_MAX_FILE_SIZE_BYTES');
    if (file.size > maxSize) {
      throw new BadRequestException(
        `File is too large (${file.size} bytes) - the maximum is ${maxSize} bytes`,
      );
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed types: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      );
    }

    const metadata = await sharp(file.buffer)
      .metadata()
      .catch(() => {
        throw new BadRequestException(
          'The uploaded file could not be decoded as a valid image - it may be corrupt or mislabeled',
        );
      });
    if (!metadata.width || !metadata.height) {
      throw new BadRequestException(
        'The uploaded file has no readable image dimensions - it may be corrupt or mislabeled',
      );
    }
    // The declared Content-Type is trusted only after a successful real
    // decode above; still cross-check the *decoded* format against the
    // same allowlist so a file that decodes as, say, TIFF but was sent
    // with a spoofed "image/png" header is caught too.
    if (!metadata.format || !ALLOWED_MIME_TYPES.has(`image/${metadata.format}`)) {
      throw new BadRequestException(
        `The uploaded file's actual content ("${metadata.format ?? 'unknown'}") does not match an allowed image type`,
      );
    }

    return {
      buffer: file.buffer,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      width: metadata.width,
      height: metadata.height,
    };
  }

  /** Saves to storage, then persists the DB row - cleans up the just-saved file if the DB write fails, so no orphaned file survives a partial failure. */
  private async persist(
    decoded: DecodedFile,
    data: { cartId: string; orderId?: string; expiresAt: Date | null },
  ): Promise<PaymentReceipt> {
    const saved = await this.storage.save(decoded.buffer, decoded.mimeType);
    try {
      return await this.prisma.paymentReceipt.create({
        data: {
          cartId: data.cartId,
          orderId: data.orderId,
          storageKey: saved.storageKey,
          mimeType: decoded.mimeType,
          sizeBytes: decoded.sizeBytes,
          width: decoded.width,
          height: decoded.height,
          expiresAt: data.expiresAt,
        },
      });
    } catch (error) {
      await this.storage.delete(saved.storageKey);
      throw error;
    }
  }

  /**
   * Pre-order upload: bound to an ACTIVE cart, unattached (orderId: null)
   * until an InstaPay order claims it. Restricted both by the route-level
   * rate limit (see ReceiptsCartController) and by a cap on how many
   * unattached uploads one cart can accumulate at once.
   */
  async uploadForCart(cartId: string, file: Express.Multer.File): Promise<{ receiptId: string }> {
    const cart = await this.prisma.cart.findUnique({ where: { id: cartId } });
    if (!cart) {
      throw new ResourceNotFoundException('Cart', cartId);
    }
    if (cart.status !== CartStatus.ACTIVE) {
      throw new AppException(
        'CART_NOT_ACTIVE',
        'This cart is no longer active - receipts can only be uploaded before checkout completes',
        HttpStatus.CONFLICT,
      );
    }

    const maxPending = this.configService.getOrThrow<number>('RECEIPT_MAX_PENDING_PER_CART');
    const pendingCount = await this.prisma.paymentReceipt.count({
      where: { cartId, orderId: null },
    });
    if (pendingCount >= maxPending) {
      throw new AppException(
        'TOO_MANY_PENDING_RECEIPTS',
        `This cart already has ${pendingCount} unattached receipt upload(s) - the limit is ${maxPending}. Complete checkout with one of them or wait for old ones to expire.`,
        HttpStatus.CONFLICT,
      );
    }

    const decoded = await this.decodeAndValidate(file);
    const retentionMinutes = this.configService.getOrThrow<number>(
      'RECEIPT_UNATTACHED_RETENTION_MINUTES',
    );
    const receipt = await this.persist(decoded, {
      cartId,
      expiresAt: new Date(Date.now() + retentionMinutes * 60_000),
    });

    return { receiptId: receipt.id };
  }

  /**
   * Loads a receipt that must (a) exist, (b) belong to this exact cart,
   * and (c) not already be attached to a different order - the three
   * checks OrdersService.createOrder needs before it can safely reference
   * a receiptId supplied by the client. Does NOT itself claim the receipt
   * - see attachToOrderInTransaction for the atomic, race-safe claim.
   */
  async findOwnedUnattachedOrThrow(cartId: string, receiptId: string): Promise<PaymentReceipt> {
    const receipt = await this.prisma.paymentReceipt.findUnique({ where: { id: receiptId } });
    if (!receipt || receipt.cartId !== cartId) {
      throw new AppException(
        'RECEIPT_NOT_FOUND',
        'No receipt upload matches this cart',
        HttpStatus.NOT_FOUND,
      );
    }
    if (receipt.orderId) {
      throw new AppException(
        'RECEIPT_ALREADY_ATTACHED',
        'This receipt has already been used for a different order',
        HttpStatus.CONFLICT,
      );
    }
    if (receipt.expiresAt && receipt.expiresAt < new Date()) {
      throw new AppException(
        'RECEIPT_EXPIRED',
        'This receipt upload has expired - please upload a new screenshot',
        HttpStatus.GONE,
      );
    }
    return receipt;
  }

  /**
   * Atomically claims an unattached receipt for an order, inside the
   * caller's own transaction (OrdersService.createOrder) - the
   * `orderId: null` guard in the WHERE clause is what actually prevents
   * two concurrent order-creation attempts from both successfully
   * claiming the same receipt (the same conditional-UPDATE pattern used
   * everywhere else in this codebase for this exact class of race - see
   * ReservationsService, coupon usage). `expiresAt` is cleared so the
   * cleanup sweep can never match this row again.
   */
  async attachToOrderInTransaction(
    tx: Prisma.TransactionClient,
    receiptId: string,
    orderId: string,
  ): Promise<void> {
    const result = await tx.paymentReceipt.updateMany({
      where: { id: receiptId, orderId: null },
      data: { orderId, expiresAt: null },
    });
    if (result.count === 0) {
      throw new AppException(
        'RECEIPT_ALREADY_ATTACHED',
        'This receipt has already been used for a different order',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Post-rejection replacement: uploads AND attaches in one call, since
   * the cart is no longer ACTIVE at this point (it already converted to
   * an order) - there is no "unattached" phase for a replacement. Never
   * touches StockReservation, so it cannot extend the order's reservation
   * deadline. Only allowed when the order is still eligible: InstaPay,
   * not cancelled, not yet paid, and its most recent receipt was REJECTED
   * (not still pending review, and not already accepted).
   */
  async uploadReplacementForCart(
    cartId: string,
    file: Express.Multer.File,
  ): Promise<{ receiptId: string }> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: { order: { include: { receipts: { orderBy: { createdAt: 'desc' }, take: 1 } } } },
    });
    if (!cart) {
      throw new ResourceNotFoundException('Cart', cartId);
    }
    const order = cart.order;
    if (!order) {
      throw new AppException(
        'ORDER_NOT_FOUND',
        'This cart has no order to attach a replacement receipt to',
        HttpStatus.NOT_FOUND,
      );
    }
    if (order.paymentMethod !== OrderPaymentMethod.INSTAPAY_MANUAL) {
      throw new AppException(
        'REPLACEMENT_NOT_APPLICABLE',
        'This order is not paid by InstaPay - no receipt is expected',
        HttpStatus.CONFLICT,
      );
    }
    if (order.fulfillmentStatus === FulfillmentStatus.CANCELLED) {
      throw new AppException(
        'ORDER_CANCELLED',
        'This order has been cancelled - a replacement receipt cannot be attached to it',
        HttpStatus.CONFLICT,
      );
    }
    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new AppException(
        'ORDER_ALREADY_PAID',
        'This order has already been marked paid - no replacement receipt is needed',
        HttpStatus.CONFLICT,
      );
    }
    const latest = order.receipts[0];
    if (!latest || latest.status !== ReceiptStatus.REJECTED) {
      throw new AppException(
        'REPLACEMENT_NOT_ALLOWED',
        latest
          ? `The current receipt is ${latest.status} - a replacement can only be submitted after rejection`
          : 'There is no receipt on file to replace',
        HttpStatus.CONFLICT,
      );
    }

    const decoded = await this.decodeAndValidate(file);
    const receipt = await this.persist(decoded, { cartId, orderId: order.id, expiresAt: null });

    await this.auditLogService.record({
      staffUserId: null,
      action: 'payment_receipt.replace',
      entityType: 'Order',
      entityId: order.id,
      metadata: { receiptId: receipt.id },
    });

    return { receiptId: receipt.id };
  }

  /** Guest access to their own upload (any cart-owned receipt, attached or not). */
  async getFileForCartOwner(
    cartId: string,
    receiptId: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const receipt = await this.prisma.paymentReceipt.findUnique({ where: { id: receiptId } });
    if (!receipt || receipt.cartId !== cartId) {
      throw new ResourceNotFoundException('PaymentReceipt', receiptId);
    }
    const buffer = await this.storage.read(receipt.storageKey);
    return { buffer, mimeType: receipt.mimeType };
  }

  /** Staff access to any receipt - role-gated at the controller, not by ownership. */
  async getFileForStaff(receiptId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const receipt = await this.prisma.paymentReceipt.findUnique({ where: { id: receiptId } });
    if (!receipt) {
      throw new ResourceNotFoundException('PaymentReceipt', receiptId);
    }
    const buffer = await this.storage.read(receipt.storageKey);
    return { buffer, mimeType: receipt.mimeType };
  }

  /**
   * Marks a specific receipt REJECTED - a distinct, audited action from
   * confirming payment (OrdersService.updatePaymentStatus). Never changes
   * Order.paymentStatus itself: rejecting proof just means the order
   * stays UNPAID/awaiting-verification, exactly as it already was. The
   * owning guest can then submit a replacement (uploadReplacementForCart).
   */
  async rejectReceipt(
    orderId: string,
    receiptId: string,
    reason: string,
    actor: AuthenticatedStaff,
  ): Promise<PaymentReceipt> {
    const receipt = await this.prisma.paymentReceipt.findUnique({ where: { id: receiptId } });
    if (!receipt || receipt.orderId !== orderId) {
      throw new ResourceNotFoundException('PaymentReceipt', receiptId);
    }
    if (receipt.status !== ReceiptStatus.PENDING_REVIEW) {
      throw new AppException(
        'INVALID_STATE_TRANSITION',
        `Receipt is already ${receipt.status} - only a receipt pending review can be rejected`,
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.paymentReceipt.update({
      where: { id: receiptId },
      data: {
        status: ReceiptStatus.REJECTED,
        rejectionReason: reason,
        reviewedByStaffId: actor.id,
        reviewedAt: new Date(),
      },
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'payment_receipt.reject',
      entityType: 'Order',
      entityId: orderId,
      metadata: { receiptId, reason },
    });

    return updated;
  }

  /**
   * Bounded cleanup of unattached uploads past their retention deadline -
   * called from ReceiptCleanupScheduler, the same @Interval pattern as
   * OrderExpiryScheduler. The `orderId: null` filter is structural: an
   * attached receipt's `expiresAt` was cleared the moment it was attached
   * (attachToOrderInTransaction / uploadReplacementForCart), so this query
   * can never match an attached receipt, by construction - an attached
   * receipt is never deleted by this sweep no matter how old it is.
   */
  async deleteExpiredUnattached(limit = 200): Promise<number> {
    const expired = await this.prisma.paymentReceipt.findMany({
      where: { orderId: null, expiresAt: { not: null, lt: new Date() } },
      select: { id: true, storageKey: true },
      take: limit,
    });

    let deleted = 0;
    for (const { id, storageKey } of expired) {
      // Re-check atomically at delete time too, in case a concurrent
      // order-creation attempt claimed this exact receipt between the
      // find above and this delete - never delete a row (or its file)
      // that just became attached.
      const result = await this.prisma.paymentReceipt.deleteMany({
        where: { id, orderId: null, expiresAt: { not: null, lt: new Date() } },
      });
      if (result.count > 0) {
        await this.storage.delete(storageKey);
        deleted += 1;
      }
    }
    if (deleted > 0) {
      this.logger.log(`Deleted ${deleted} expired unattached payment receipt(s)`);
    }
    return deleted;
  }
}
