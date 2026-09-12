import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, ShippingRate, ShippingZone } from '@prisma/client';
import { AppException, ResourceNotFoundException } from '../../common/exceptions/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../auth/types/authenticated-staff.type';
import { CreateShippingRateDto } from './dto/create-shipping-rate.dto';
import { CreateShippingZoneDto } from './dto/create-shipping-zone.dto';
import { UpdateShippingRateDto } from './dto/update-shipping-rate.dto';
import { UpdateShippingZoneDto } from './dto/update-shipping-zone.dto';

/**
 * Applies a rate's free-shipping threshold, if any, against `basisAmount`.
 *
 * The threshold is compared against the order's **post-discount total**
 * (i.e. what the customer is actually paying for goods), not the
 * pre-discount subtotal - see docs/BUSINESS_RULES.md for why this basis
 * was chosen and how to change it if the business wants the other rule.
 * This is a pure function so the rule is directly unit-testable without a
 * database.
 */
export function computeShippingPrice(
  rate: Pick<ShippingRate, 'price' | 'freeShippingThreshold'>,
  basisAmount: number,
): number {
  if (rate.freeShippingThreshold !== null && basisAmount >= rate.freeShippingThreshold) {
    return 0;
  }
  return rate.price;
}

@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // --- Zones ---------------------------------------------------------

  async createZone(dto: CreateShippingZoneDto, actor: AuthenticatedStaff): Promise<ShippingZone> {
    const zone = await this.prisma.shippingZone.create({
      data: { ...dto, countries: dto.countries.map((c) => c.toUpperCase()) },
    });
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'shipping_zone.create',
      entityType: 'ShippingZone',
      entityId: zone.id,
      metadata: { countries: zone.countries },
    });
    return zone;
  }

  async findAllZones(): Promise<ShippingZone[]> {
    return this.prisma.shippingZone.findMany({
      include: { rates: true },
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
    });
  }

  async findZoneByIdOrThrow(id: string): Promise<ShippingZone> {
    const zone = await this.prisma.shippingZone.findUnique({
      where: { id },
      include: { rates: true },
    });
    if (!zone) {
      throw new ResourceNotFoundException('ShippingZone', id);
    }
    return zone;
  }

  async updateZone(
    id: string,
    dto: UpdateShippingZoneDto,
    actor: AuthenticatedStaff,
  ): Promise<ShippingZone> {
    await this.findZoneByIdOrThrow(id);
    const zone = await this.prisma.shippingZone.update({
      where: { id },
      data: { ...dto, countries: dto.countries?.map((c) => c.toUpperCase()) },
    });
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'shipping_zone.update',
      entityType: 'ShippingZone',
      entityId: zone.id,
      metadata: { changes: dto },
    });
    return zone;
  }

  // --- Rates -----------------------------------------------------------

  async createRate(
    zoneId: string,
    dto: CreateShippingRateDto,
    actor: AuthenticatedStaff,
  ): Promise<ShippingRate> {
    await this.findZoneByIdOrThrow(zoneId);
    try {
      const rate = await this.prisma.shippingRate.create({ data: { ...dto, zoneId } });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'shipping_rate.create',
        entityType: 'ShippingRate',
        entityId: rate.id,
        metadata: { zoneId, price: rate.price },
      });
      return rate;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new ResourceNotFoundException('ShippingZone', zoneId);
      }
      throw error;
    }
  }

  async findRatesForZone(zoneId: string): Promise<ShippingRate[]> {
    await this.findZoneByIdOrThrow(zoneId);
    return this.prisma.shippingRate.findMany({
      where: { zoneId },
      orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }],
    });
  }

  async findRateByIdOrThrow(rateId: string): Promise<ShippingRate & { zone: ShippingZone }> {
    const rate = await this.prisma.shippingRate.findUnique({
      where: { id: rateId },
      include: { zone: true },
    });
    if (!rate) {
      throw new ResourceNotFoundException('ShippingRate', rateId);
    }
    return rate;
  }

  async updateRate(
    zoneId: string,
    rateId: string,
    dto: UpdateShippingRateDto,
    actor: AuthenticatedStaff,
  ): Promise<ShippingRate> {
    const rate = await this.prisma.shippingRate.findFirst({ where: { id: rateId, zoneId } });
    if (!rate) {
      throw new ResourceNotFoundException('ShippingRate', rateId);
    }
    const updated = await this.prisma.shippingRate.update({ where: { id: rateId }, data: dto });
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'shipping_rate.update',
      entityType: 'ShippingRate',
      entityId: updated.id,
      metadata: { changes: dto },
    });
    return updated;
  }

  // --- Storefront/checkout lookups --------------------------------------

  /**
   * Active rates available for a destination country. A country matching
   * no active zone returns an empty list - CheckoutService turns that
   * into an explicit "unsupported destination" error rather than letting
   * the customer silently see no shipping options.
   */
  async findActiveRatesForCountry(countryCode: string): Promise<ShippingRate[]> {
    const country = countryCode.toUpperCase();
    return this.prisma.shippingRate.findMany({
      where: { isActive: true, zone: { isActive: true, countries: { has: country } } },
      orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }],
    });
  }

  /**
   * Resolves one specific rate for checkout, ensuring it actually covers
   * the given destination country and is currently active - a rate id
   * alone is not sufficient (a customer could otherwise pick an
   * out-of-zone or deactivated rate).
   */
  async resolveRateForCheckout(rateId: string, countryCode: string): Promise<ShippingRate> {
    const country = countryCode.toUpperCase();
    const rate = await this.prisma.shippingRate.findFirst({
      where: { id: rateId, isActive: true, zone: { isActive: true, countries: { has: country } } },
    });
    if (!rate) {
      throw new AppException(
        'SHIPPING_RATE_NOT_AVAILABLE',
        'The selected shipping option is not available for this destination',
        HttpStatus.CONFLICT,
      );
    }
    return rate;
  }
}
