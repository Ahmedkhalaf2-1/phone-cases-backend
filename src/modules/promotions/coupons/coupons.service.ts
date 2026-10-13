import { BadRequestException, Injectable } from '@nestjs/common';
import { Coupon, CouponType, Prisma } from '@prisma/client';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { resolveScheduleWindow } from '../../../common/schedule/schedule-window.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { computeCouponStatus, CouponStatus } from './coupon-status.util';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';

/** Admin API shape: the stored coupon plus a server-computed lifecycle state. */
export type CouponWithStatus = Coupon & { status: CouponStatus };

@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private withStatus(coupon: Coupon): CouponWithStatus {
    return { ...coupon, status: computeCouponStatus(coupon) };
  }

  async create(dto: CreateCouponDto, actor: AuthenticatedStaff): Promise<CouponWithStatus> {
    this.assertValueIsValid(dto.type, dto.value);
    const schedule = resolveScheduleWindow(dto);
    const code = dto.code.toUpperCase();

    try {
      const coupon = await this.prisma.coupon.create({
        data: {
          code,
          type: dto.type,
          value: dto.value,
          minSpend: dto.minSpend,
          startsAt: schedule.startsAt,
          expiresAt: schedule.expiresAt,
          usageLimit: dto.usageLimit,
          isActive: dto.isActive,
        },
      });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'coupon.create',
        entityType: 'Coupon',
        entityId: coupon.id,
        metadata: { code: coupon.code, type: coupon.type, value: coupon.value },
      });
      return this.withStatus(coupon);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceException(
          'COUPON_CODE_TAKEN',
          `A coupon with code "${code}" already exists`,
        );
      }
      throw error;
    }
  }

  async findAll(): Promise<CouponWithStatus[]> {
    const coupons = await this.prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } });
    return coupons.map((coupon) => this.withStatus(coupon));
  }

  private async findRowOrThrow(id: string): Promise<Coupon> {
    const coupon = await this.prisma.coupon.findUnique({ where: { id } });
    if (!coupon) {
      throw new ResourceNotFoundException('Coupon', id);
    }
    return coupon;
  }

  async findByIdOrThrow(id: string): Promise<CouponWithStatus> {
    return this.withStatus(await this.findRowOrThrow(id));
  }

  async update(
    id: string,
    dto: UpdateCouponDto,
    actor: AuthenticatedStaff,
  ): Promise<CouponWithStatus> {
    const existing = await this.findRowOrThrow(id);
    const effectiveType = dto.type ?? existing.type;
    const effectiveValue = dto.value ?? existing.value;
    this.assertValueIsValid(effectiveType, effectiveValue);
    const schedule = resolveScheduleWindow(dto, existing);

    try {
      const coupon = await this.prisma.coupon.update({
        where: { id },
        data: {
          code: dto.code ? dto.code.toUpperCase() : undefined,
          type: dto.type,
          value: dto.value,
          minSpend: dto.minSpend,
          startsAt: schedule.startsAt,
          expiresAt: schedule.expiresAt,
          usageLimit: dto.usageLimit,
          isActive: dto.isActive,
        },
      });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'coupon.update',
        entityType: 'Coupon',
        entityId: coupon.id,
        metadata: { changes: dto },
      });
      return this.withStatus(coupon);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceException(
          'COUPON_CODE_TAKEN',
          `A coupon with code "${dto.code}" already exists`,
        );
      }
      throw error;
    }
  }

  private assertValueIsValid(type: CouponType, value: number): void {
    if (type === CouponType.PERCENTAGE && (value < 1 || value > 100)) {
      throw new BadRequestException('A PERCENTAGE coupon value must be between 1 and 100');
    }
    if (type === CouponType.FIXED && value <= 0) {
      throw new BadRequestException(
        'A FIXED coupon value must be a positive number of minor units',
      );
    }
  }
}
