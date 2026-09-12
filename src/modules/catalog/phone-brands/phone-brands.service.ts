import { Injectable } from '@nestjs/common';
import { Prisma, PhoneBrand } from '@prisma/client';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreatePhoneBrandDto } from './dto/create-phone-brand.dto';
import { UpdatePhoneBrandDto } from './dto/update-phone-brand.dto';

@Injectable()
export class PhoneBrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreatePhoneBrandDto, actor: AuthenticatedStaff): Promise<PhoneBrand> {
    try {
      const brand = await this.prisma.phoneBrand.create({ data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'phone_brand.create',
        entityType: 'PhoneBrand',
        entityId: brand.id,
        metadata: { slug: brand.slug },
      });
      return brand;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  async findAllForAdmin(): Promise<PhoneBrand[]> {
    return this.prisma.phoneBrand.findMany({
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
    });
  }

  async findAllActive(): Promise<PhoneBrand[]> {
    return this.prisma.phoneBrand.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
    });
  }

  async findByIdOrThrow(id: string): Promise<PhoneBrand> {
    const brand = await this.prisma.phoneBrand.findUnique({ where: { id } });
    if (!brand) {
      throw new ResourceNotFoundException('PhoneBrand', id);
    }
    return brand;
  }

  async update(
    id: string,
    dto: UpdatePhoneBrandDto,
    actor: AuthenticatedStaff,
  ): Promise<PhoneBrand> {
    await this.findByIdOrThrow(id);
    try {
      const brand = await this.prisma.phoneBrand.update({ where: { id }, data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'phone_brand.update',
        entityType: 'PhoneBrand',
        entityId: brand.id,
        metadata: { changes: dto },
      });
      return brand;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  private rethrowIfDuplicateSlug(error: unknown, slug: string | undefined): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && slug) {
      throw new DuplicateResourceException(
        'PHONE_BRAND_SLUG_TAKEN',
        `A phone brand with slug "${slug}" already exists`,
      );
    }
  }
}
