import { INestApplication } from '@nestjs/common';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReservationsService } from '../src/modules/inventory/reservations/reservations.service';
import { createTestApp, resetDatabase } from './utils/test-app';

describe('ReservationsService (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reservations: ReservationsService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    reservations = app.get(ReservationsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  async function createStockItem(onHand: number) {
    return prisma.stockItem.create({
      data: { sku: `SKU-${Date.now()}-${Math.random()}`, nameEn: 'Blank', onHand },
    });
  }

  it('reserves stock, increasing reserved without touching onHand', async () => {
    const stockItem = await createStockItem(10);

    const reservation = await reservations.reserve({ stockItemId: stockItem.id, quantity: 4 });

    expect(reservation.status).toBe(ReservationStatus.ACTIVE);
    const updated = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(updated.onHand).toBe(10);
    expect(updated.reserved).toBe(4);
  });

  it('refuses to reserve more than is available', async () => {
    const stockItem = await createStockItem(3);

    await expect(
      reservations.reserve({ stockItemId: stockItem.id, quantity: 4 }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });

    const unchanged = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(unchanged.reserved).toBe(0);
  });

  it('accounts for existing reservations when checking availability', async () => {
    const stockItem = await createStockItem(5);
    await reservations.reserve({ stockItemId: stockItem.id, quantity: 5 });

    await expect(
      reservations.reserve({ stockItemId: stockItem.id, quantity: 1 }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });
  });

  it('release() reverts the reserved quantity without changing onHand', async () => {
    const stockItem = await createStockItem(10);
    const reservation = await reservations.reserve({ stockItemId: stockItem.id, quantity: 4 });

    const released = await reservations.release(reservation.id);

    expect(released.status).toBe(ReservationStatus.RELEASED);
    const updated = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(updated.onHand).toBe(10);
    expect(updated.reserved).toBe(0);
  });

  it('release() is idempotent for an already-released reservation', async () => {
    const stockItem = await createStockItem(10);
    const reservation = await reservations.reserve({ stockItemId: stockItem.id, quantity: 4 });
    await reservations.release(reservation.id);

    const secondRelease = await reservations.release(reservation.id);
    expect(secondRelease.status).toBe(ReservationStatus.RELEASED);

    const updated = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(updated.reserved).toBe(0);
  });

  it('consume() decrements onHand and records a stock movement', async () => {
    const stockItem = await createStockItem(10);
    const reservation = await reservations.reserve({ stockItemId: stockItem.id, quantity: 4 });

    const consumed = await reservations.consume(reservation.id);

    expect(consumed.status).toBe(ReservationStatus.CONSUMED);
    const updated = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(updated.onHand).toBe(6);
    expect(updated.reserved).toBe(0);

    const movements = await prisma.stockMovement.findMany({ where: { stockItemId: stockItem.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0].delta).toBe(-4);
    expect(movements[0].reason).toBe('reservation_consumed');
  });

  it('refuses to consume a reservation that is not ACTIVE', async () => {
    const stockItem = await createStockItem(10);
    const reservation = await reservations.reserve({ stockItemId: stockItem.id, quantity: 4 });
    await reservations.release(reservation.id);

    await expect(reservations.consume(reservation.id)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('releaseAllExpired() releases only expired ACTIVE reservations', async () => {
    // Two separate stock items: reserving on `freshItem` must not
    // side-effect `expiringItem`'s reservation via the lazy per-stock-item
    // sweep inside reserve() - that sweep only ever looks at the stock
    // item it is currently reserving against (see reserve() in
    // ReservationsService), so releaseAllExpired()'s cross-stock-item
    // sweep is the only thing that should touch `expiring` here.
    const expiringItem = await createStockItem(10);
    const freshItem = await createStockItem(10);
    const expiring = await reservations.reserve({
      stockItemId: expiringItem.id,
      quantity: 2,
      ttlMinutes: -1,
    });
    const fresh = await reservations.reserve({ stockItemId: freshItem.id, quantity: 3 });

    const released = await reservations.releaseAllExpired();

    expect(released).toHaveLength(1);
    const expiredReservation = await prisma.stockReservation.findUniqueOrThrow({
      where: { id: expiring.id },
    });
    expect(expiredReservation.status).toBe(ReservationStatus.EXPIRED);
    const freshReservation = await prisma.stockReservation.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(freshReservation.status).toBe(ReservationStatus.ACTIVE);

    const updatedExpiringItem = await prisma.stockItem.findUniqueOrThrow({
      where: { id: expiringItem.id },
    });
    expect(updatedExpiringItem.reserved).toBe(0);
    const updatedFreshItem = await prisma.stockItem.findUniqueOrThrow({
      where: { id: freshItem.id },
    });
    expect(updatedFreshItem.reserved).toBe(3);
  });

  it('lazily releases an expired reservation on the same stock item before granting a new one', async () => {
    const stockItem = await createStockItem(5);
    const expiring = await reservations.reserve({
      stockItemId: stockItem.id,
      quantity: 5,
      ttlMinutes: -1,
    });

    // Without the lazy sweep, this would fail with INSUFFICIENT_STOCK
    // since the expired reservation still holds all 5 units as "reserved".
    const next = await reservations.reserve({ stockItemId: stockItem.id, quantity: 5 });

    expect(next.status).toBe(ReservationStatus.ACTIVE);
    const expiredReservation = await prisma.stockReservation.findUniqueOrThrow({
      where: { id: expiring.id },
    });
    expect(expiredReservation.status).toBe(ReservationStatus.EXPIRED);
    const updated = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(updated.reserved).toBe(5);
  });

  it('pinActiveForOrderInTransaction sets expiresAt to null, taking the reservation out of releaseAllExpired reach', async () => {
    const stockItem = await createStockItem(10);
    const order = await prisma.order.create({
      data: {
        trackingToken: `track-${Date.now()}-${Math.random()}`,
        idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
        idempotencyRequestHash: 'hash',
        currency: 'EGP',
        subtotal: 1000,
        discountTotal: 0,
        shippingTotal: 0,
        total: 1000,
        shippingRateNameEn: 'Standard',
        customerFullName: 'Test',
        customerPhone: '01012345678',
        shippingCountry: 'EG',
        shippingCity: 'Cairo',
        shippingAddressLine1: 'Test St',
      },
    });
    // A reservation whose TTL already elapsed - proves pinning overrides
    // an existing expiry, not just a freshly-created one.
    const reservation = await reservations.reserve({
      stockItemId: stockItem.id,
      quantity: 2,
      orderId: order.id,
      ttlMinutes: -1,
    });

    await prisma.$transaction((tx) => reservations.pinActiveForOrderInTransaction(tx, order.id));

    const pinned = await prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(pinned.expiresAt).toBeNull();
    expect(pinned.status).toBe(ReservationStatus.ACTIVE);

    const released = await reservations.releaseAllExpired();
    expect(released).toHaveLength(0);
    const stillActive = await prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(stillActive.status).toBe(ReservationStatus.ACTIVE);
    const stock = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(stock.reserved).toBe(2);
  });

  it('never lets reserved exceed onHand under concurrent reservation attempts', async () => {
    const stockItem = await createStockItem(5);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        reservations.reserve({ stockItemId: stockItem.id, quantity: 1 }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(5);
    expect(failed).toHaveLength(3);

    const updated = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(updated.reserved).toBe(5);
  });
});
