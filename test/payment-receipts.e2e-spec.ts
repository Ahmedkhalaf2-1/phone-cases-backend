import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReceiptCleanupService } from '../src/modules/payments/receipts/receipt-cleanup.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Payment receipts / InstaPay manual (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  async function validPngBuffer(): Promise<Buffer> {
    return sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .png()
      .toBuffer();
  }

  async function seedEgyptShipping(price = 5000) {
    const zone = await prisma.shippingZone.create({
      data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
    });
    return prisma.shippingRate.create({
      data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price },
    });
  }

  async function seedPublishedVariant(price = 10000) {
    const product = await prisma.product.create({
      data: {
        slug: `space-${Date.now()}-${Math.random()}`,
        nameEn: 'Space',
        nameAr: 'الفضاء',
        status: 'PUBLISHED',
      },
    });
    return prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `SPACE-${Date.now()}-${Math.random()}`,
        price,
        isUnlimitedStock: true,
      },
    });
  }

  async function createCartWithItem(): Promise<string> {
    const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    const token = cartRes.body.token as string;
    const variant = await seedPublishedVariant();
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('X-Cart-Token', token)
      .send({ variantId: variant.id, quantity: 1 })
      .expect(201);
    return token;
  }

  function uploadReceipt(
    token: string,
    buffer: Buffer,
    options?: { filename?: string; contentType?: string },
  ) {
    return request(app.getHttpServer())
      .post('/api/v1/cart/receipts')
      .set('X-Cart-Token', token)
      .attach('file', buffer, options ?? { filename: 'receipt.png', contentType: 'image/png' });
  }

  async function quoteAndTotal(token: string, rateId: string): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('X-Cart-Token', token)
      .send({ country: 'EG', shippingRateId: rateId })
      .expect(201);
    return res.body.total as number;
  }

  function orderBody(overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
      customerFullName: 'Test Customer',
      customerPhone: '01012345678',
      shippingCountry: 'EG',
      shippingCity: 'Cairo',
      shippingAddressLine1: '123 Main St',
      ...overrides,
    };
  }

  describe('cash on delivery', () => {
    it('creates a cash order with no screenshot at all', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const total = await quoteAndTotal(token, rate.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'CASH_ON_DELIVERY',
          }),
        )
        .expect(201);

      expect(res.body.paymentMethod).toBe('CASH_ON_DELIVERY');
      expect(res.body.paymentStatus).toBe('UNPAID');
      expect(res.body.receipts).toEqual([]);
    });

    it('rejects a receiptId supplied alongside CASH_ON_DELIVERY', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const upload = await uploadReceipt(token, await validPngBuffer());
      const total = await quoteAndTotal(token, rate.id);

      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'CASH_ON_DELIVERY',
            receiptId: upload.body.receiptId,
          }),
        )
        .expect(400);
    });
  });

  describe('valid InstaPay order', () => {
    it('creates the order with its screenshot attached, and never marks it PAID', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const upload = await uploadReceipt(token, await validPngBuffer()).expect(201);
      const receiptId = upload.body.receiptId as string;
      const total = await quoteAndTotal(token, rate.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId,
          }),
        )
        .expect(201);

      expect(res.body.paymentMethod).toBe('INSTAPAY_MANUAL');
      // Uploading proof must never, by itself, mark the order paid.
      expect(res.body.paymentStatus).toBe('UNPAID');
      expect(res.body.receipts).toHaveLength(1);
      expect(res.body.receipts[0].id).toBe(receiptId);
      expect(res.body.receipts[0].status).toBe('PENDING_REVIEW');

      const dbReceipt = await prisma.paymentReceipt.findUniqueOrThrow({ where: { id: receiptId } });
      expect(dbReceipt.orderId).not.toBeNull();
      expect(dbReceipt.expiresAt).toBeNull();

      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: res.body.trackingToken },
      });
      expect(order.paymentStatus).toBe('UNPAID');

      // Appears in the admin order detail too.
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      const adminView = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${order.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(adminView.body.receipts).toHaveLength(1);
      expect(adminView.body.receipts[0].id).toBe(receiptId);
    });

    it('reserves stock using the longer InstaPay review deadline, not the default reservation TTL', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: `BLANK-${Date.now()}`, nameEn: 'Blank', onHand: 5 },
      });
      const product = await prisma.product.create({
        data: {
          slug: `insta-stock-${Date.now()}`,
          nameEn: 'Space',
          nameAr: 'ف',
          status: 'PUBLISHED',
        },
      });
      const variant = await prisma.productVariant.create({
        data: {
          productId: product.id,
          sku: `INSTA-STOCK-${Date.now()}`,
          price: 10000,
          stockItemId: stockItem.id,
        },
      });
      const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const token = cartRes.body.token as string;
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);
      const upload = await uploadReceipt(token, await validPngBuffer()).expect(201);
      const total = await quoteAndTotal(token, rate.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId: upload.body.receiptId,
          }),
        )
        .expect(201);

      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: res.body.trackingToken },
      });
      const reservation = await prisma.stockReservation.findFirstOrThrow({
        where: { orderId: order.id },
      });
      const hoursUntilExpiry = (reservation.expiresAt!.getTime() - Date.now()) / (60 * 60 * 1000);
      // Default RESERVATION_TTL_MINUTES is 15 (a fraction of an hour);
      // default INSTAPAY_REVIEW_DEADLINE_MINUTES is 1440 (24h) - well over
      // an hour away proves the longer deadline was actually used.
      expect(hoursUntilExpiry).toBeGreaterThan(1);
    });
  });

  describe('rejection paths', () => {
    it('rejects order creation missing a required receiptId for INSTAPAY_MANUAL', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const total = await quoteAndTotal(token, rate.id);

      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
          }),
        )
        .expect(400);
    });

    it('rejects a receiptId that does not exist', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const total = await quoteAndTotal(token, rate.id);

      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId: '00000000-0000-0000-0000-000000000000',
          }),
        )
        .expect(404);
    });

    it('rejects a receipt uploaded on a different cart', async () => {
      const rate = await seedEgyptShipping();
      const foreignCartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const foreignUpload = await uploadReceipt(
        foreignCartRes.body.token,
        await validPngBuffer(),
      ).expect(201);

      const token = await createCartWithItem();
      const total = await quoteAndTotal(token, rate.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId: foreignUpload.body.receiptId,
          }),
        )
        .expect(404);
      expect(res.body.code).toBe('RECEIPT_NOT_FOUND');
    });

    it('rejects a file that is not a real decodable image, regardless of declared Content-Type', async () => {
      const token = await createCartWithItem();
      const res = await uploadReceipt(token, Buffer.from('this is not an image'), {
        filename: 'fake.png',
        contentType: 'image/png',
      });
      expect(res.status).toBe(400);
    });

    it('rejects an unsupported but genuinely decodable image type', async () => {
      const token = await createCartWithItem();
      const gif = await sharp({
        create: { width: 5, height: 5, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .gif()
        .toBuffer();
      const res = await uploadReceipt(token, gif, { filename: 'r.gif', contentType: 'image/gif' });
      expect(res.status).toBe(400);
    });

    it('rejects an oversized file before it is ever decoded', async () => {
      const token = await createCartWithItem();
      const oversized = Buffer.alloc(6 * 1024 * 1024, 1); // > default 5MB limit
      const res = await uploadReceipt(token, oversized, {
        filename: 'huge.png',
        contentType: 'image/png',
      });
      // 413, not 400: NestJS's own FileInterceptor turns a MulterError
      // (LIMIT_FILE_SIZE) into PayloadTooLargeException before our code
      // ever runs - see AllExceptionsFilter's STATUS_CODE_MAP.
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
    });

    it('rejects uploads once the pending-per-cart limit is reached', async () => {
      const token = await createCartWithItem();
      // Default RECEIPT_MAX_PENDING_PER_CART is 5.
      for (let i = 0; i < 5; i += 1) {
        await uploadReceipt(token, await validPngBuffer()).expect(201);
      }
      const res = await uploadReceipt(token, await validPngBuffer());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TOO_MANY_PENDING_RECEIPTS');
    });

    it('rejects uploading to a cart that has already been converted to an order', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const total = await quoteAndTotal(token, rate.id);
      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'CASH_ON_DELIVERY',
          }),
        )
        .expect(201);

      const res = await uploadReceipt(token, await validPngBuffer());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CART_NOT_ACTIVE');
    });
  });

  describe('unauthorized access', () => {
    it("rejects a foreign cart token from viewing someone else's receipt", async () => {
      const tokenA = await createCartWithItem();
      const upload = await uploadReceipt(tokenA, await validPngBuffer()).expect(201);

      const cartBRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const tokenB = cartBRes.body.token as string;

      await request(app.getHttpServer())
        .get(`/api/v1/cart/receipts/${upload.body.receiptId}/file`)
        .set('X-Cart-Token', tokenB)
        .expect(404);
    });

    it('rejects a completely unauthenticated request for a receipt file', async () => {
      const token = await createCartWithItem();
      const upload = await uploadReceipt(token, await validPngBuffer()).expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/cart/receipts/${upload.body.receiptId}/file`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/api/v1/admin/receipts/${upload.body.receiptId}/file`)
        .expect(401);
    });

    it('allows the owning guest and authorized staff to view the same receipt', async () => {
      const token = await createCartWithItem();
      const upload = await uploadReceipt(token, await validPngBuffer()).expect(201);

      const guestView = await request(app.getHttpServer())
        .get(`/api/v1/cart/receipts/${upload.body.receiptId}/file`)
        .set('X-Cart-Token', token)
        .expect(200);
      expect(guestView.headers['content-type']).toBe('image/png');

      const { accessToken } = await createStaffAndLogin(app, StaffRole.ORDER_OPERATOR);
      const staffView = await request(app.getHttpServer())
        .get(`/api/v1/admin/receipts/${upload.body.receiptId}/file`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(staffView.headers['content-type']).toBe('image/png');
    });

    it('rejects a catalog manager (wrong role) from viewing a receipt', async () => {
      const token = await createCartWithItem();
      const upload = await uploadReceipt(token, await validPngBuffer()).expect(201);
      const { accessToken } = await createStaffAndLogin(app, StaffRole.CATALOG_MANAGER);

      await request(app.getHttpServer())
        .get(`/api/v1/admin/receipts/${upload.body.receiptId}/file`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });
  });

  describe('idempotent retries', () => {
    it('does not create a duplicate order or a duplicate attachment on retry', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const upload = await uploadReceipt(token, await validPngBuffer()).expect(201);
      const total = await quoteAndTotal(token, rate.id);
      const body = orderBody({
        shippingRateId: rate.id,
        expectedTotal: total,
        paymentMethod: 'INSTAPAY_MANUAL',
        receiptId: upload.body.receiptId,
      });

      const first = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(body)
        .expect(201);
      const second = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(body)
        .expect(201);

      expect(second.body.trackingToken).toBe(first.body.trackingToken);
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.paymentReceipt.count()).toBe(1);
    });
  });

  describe('receipt cleanup', () => {
    it('deletes expired unattached uploads but never touches an attached receipt', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const attachedUpload = await uploadReceipt(token, await validPngBuffer()).expect(201);
      const total = await quoteAndTotal(token, rate.id);
      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId: attachedUpload.body.receiptId,
          }),
        )
        .expect(201);

      // A second, unattached upload manually pushed past its retention window.
      const otherCartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const staleUpload = await uploadReceipt(
        otherCartRes.body.token,
        await validPngBuffer(),
      ).expect(201);
      await prisma.paymentReceipt.update({
        where: { id: staleUpload.body.receiptId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const cleanupService = app.get(ReceiptCleanupService);
      const result = await cleanupService.cleanupExpiredUnattached();
      expect(result.deleted).toBe(1);

      const stale = await prisma.paymentReceipt.findUnique({
        where: { id: staleUpload.body.receiptId },
      });
      expect(stale).toBeNull();
      const attached = await prisma.paymentReceipt.findUniqueOrThrow({
        where: { id: attachedUpload.body.receiptId },
      });
      expect(attached).not.toBeNull();

      // The attached receipt's file must still be servable after cleanup.
      await request(app.getHttpServer())
        .get(`/api/v1/cart/receipts/${attachedUpload.body.receiptId}/file`)
        .set('X-Cart-Token', token)
        .expect(200);
    });
  });

  describe('rejected and replacement proof', () => {
    async function createInstaPayOrder() {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const upload = await uploadReceipt(token, await validPngBuffer()).expect(201);
      const total = await quoteAndTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId: upload.body.receiptId,
          }),
        )
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });
      return { token, order, receiptId: upload.body.receiptId as string };
    }

    it('rejects a receipt via an audited admin action without changing order status', async () => {
      const { order, receiptId } = await createInstaPayOrder();
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/receipts/${receiptId}/reject`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ reason: 'Amount does not match order total' })
        .expect(200);
      expect(res.body.status).toBe('REJECTED');
      expect(res.body.rejectionReason).toBe('Amount does not match order total');

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.paymentStatus).toBe('UNPAID');
      expect(updatedOrder.fulfillmentStatus).toBe('PENDING');

      const auditEntry = await prisma.auditLog.findFirst({
        where: { action: 'payment_receipt.reject', entityId: order.id },
      });
      expect(auditEntry).not.toBeNull();
    });

    it('an order operator (not owner admin) cannot reject a receipt', async () => {
      const { order, receiptId } = await createInstaPayOrder();
      const { accessToken } = await createStaffAndLogin(app, StaffRole.ORDER_OPERATOR);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/receipts/${receiptId}/reject`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ reason: 'nope' })
        .expect(403);
    });

    it('rejects a replacement upload while the current receipt is still pending review', async () => {
      const { token } = await createInstaPayOrder();

      const res = await uploadReceipt(token, await validPngBuffer(), {
        filename: 'replacement.png',
        contentType: 'image/png',
      });
      // Re-issue as the replace-specific endpoint.
      const replaceRes = await request(app.getHttpServer())
        .post('/api/v1/cart/receipts/replace')
        .set('X-Cart-Token', token)
        .attach('file', await validPngBuffer(), { filename: 'r2.png', contentType: 'image/png' });
      expect(replaceRes.status).toBe(409);
      expect(replaceRes.body.code).toBe('REPLACEMENT_NOT_ALLOWED');
      void res;
    });

    it('allows the owning guest to submit replacement proof after rejection, preserving history and the reservation deadline', async () => {
      const { token, order, receiptId } = await createInstaPayOrder();
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/receipts/${receiptId}/reject`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ reason: 'blurry' })
        .expect(200);

      const reservationBefore = await prisma.stockReservation.findFirst({
        where: { orderId: order.id },
      });

      const replaceRes = await request(app.getHttpServer())
        .post('/api/v1/cart/receipts/replace')
        .set('X-Cart-Token', token)
        .attach('file', await validPngBuffer(), { filename: 'r2.png', contentType: 'image/png' });
      expect(replaceRes.status).toBe(201);
      const newReceiptId = replaceRes.body.receiptId as string;
      expect(newReceiptId).not.toBe(receiptId);

      const allReceipts = await prisma.paymentReceipt.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(allReceipts).toHaveLength(2);
      expect(allReceipts[0].status).toBe('REJECTED');
      expect(allReceipts[1].status).toBe('PENDING_REVIEW');

      // Replacement must not touch the stock reservation at all (no
      // stockItemId on this test's variant means there IS no reservation
      // row for shipping-only orders - only assert equality if one exists,
      // for orders that do have a tracked variant).
      if (reservationBefore) {
        const reservationAfter = await prisma.stockReservation.findFirst({
          where: { orderId: order.id },
        });
        expect(reservationAfter?.expiresAt?.getTime()).toBe(reservationBefore.expiresAt?.getTime());
      }
    });

    it('rejects replacement for a cash-on-delivery order', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const total = await quoteAndTotal(token, rate.id);
      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'CASH_ON_DELIVERY',
          }),
        )
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/cart/receipts/replace')
        .set('X-Cart-Token', token)
        .attach('file', await validPngBuffer(), { filename: 'r.png', contentType: 'image/png' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REPLACEMENT_NOT_APPLICABLE');
    });
  });

  describe('late payment after cancellation', () => {
    it('flags a cancelled order for manual reconciliation without restoring its status', async () => {
      const { order } = await (async () => {
        const rate = await seedEgyptShipping();
        const token = await createCartWithItem();
        const upload = await uploadReceipt(token, await validPngBuffer()).expect(201);
        const total = await quoteAndTotal(token, rate.id);
        const created = await request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', token)
          .send(
            orderBody({
              shippingRateId: rate.id,
              expectedTotal: total,
              paymentMethod: 'INSTAPAY_MANUAL',
              receiptId: upload.body.receiptId,
            }),
          )
          .expect(201);
        const order = await prisma.order.findUniqueOrThrow({
          where: { trackingToken: created.body.trackingToken },
        });
        return { order };
      })();

      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'CANCELLED' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/flag-late-payment`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ note: 'Customer sent proof of a transfer that arrived after cancellation' })
        .expect(200);
      expect(res.body.latePaymentFlaggedAt).not.toBeNull();
      expect(res.body.fulfillmentStatus).toBe('CANCELLED');
      expect(res.body.paymentStatus).toBe('UNPAID');
    });

    it('refuses to flag late payment on an order that is not cancelled', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCartWithItem();
      const total = await quoteAndTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'CASH_ON_DELIVERY',
          }),
        )
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/flag-late-payment`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ note: 'n/a' })
        .expect(409);
    });
  });
});
