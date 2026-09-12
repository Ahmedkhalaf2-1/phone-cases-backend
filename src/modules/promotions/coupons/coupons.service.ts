import { BadRequestException, Injectable } from '@nestjs/common';
import { Coupon, CouponType, Prisma } from '@prisma/client';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';

@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateCouponDto, actor: AuthenticatedStaff): Promise<Coupon> {
    this.assertValueIsValid(dto.type, dto.value);
    const code = dto.code.toUpperCase();

    try {
      const coupon = await this.prisma.coupon.create({
        data: {
          code,
          type: dto.type,
          value: dto.value,
          minSpend: dto.minSpend,
          startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
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
      return coupon;
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

  async findAll(): Promise<Coupon[]> {
    return this.prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findByIdOrThrow(id: string): Promise<Coupon> {
    const coupon = await this.prisma.coupon.findUnique({ where: { id } });
    if (!coupon) {
      throw new ResourceNotFoundException('Coupon', id);
    }
    return coupon;
  }

  async update(id: string, dto: UpdateCouponDto, actor: AuthenticatedStaff): Promise<Coupon> {
    const existing = await this.findByIdOrThrow(id);
    const effectiveType = dto.type ?? existing.type;
    const effectiveValue = dto.value ?? existing.value;
    this.assertValueIsValid(effectiveType, effectiveValue);

    try {
      const coupon = await this.prisma.coupon.update({
        where: { id },
        data: {
          code: dto.code ? dto.code.toUpperCase() : undefined,
          type: dto.type,
          value: dto.value,
          minSpend: dto.minSpend,
          startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
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
      return coupon;
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
