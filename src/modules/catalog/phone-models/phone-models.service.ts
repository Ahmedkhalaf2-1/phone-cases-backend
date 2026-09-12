import { Injectable } from '@nestjs/common';
import { Prisma, PhoneModel } from '@prisma/client';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreatePhoneModelDto } from './dto/create-phone-model.dto';
import { UpdatePhoneModelDto } from './dto/update-phone-model.dto';

const PHONE_MODEL_WITH_BRAND = { include: { brand: true } } satisfies Prisma.PhoneModelDefaultArgs;
export type PhoneModelWithBrand = Prisma.PhoneModelGetPayload<typeof PHONE_MODEL_WITH_BRAND>;

@Injectable()
export class PhoneModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreatePhoneModelDto, actor: AuthenticatedStaff): Promise<PhoneModel> {
    try {
      const model = await this.prisma.phoneModel.create({ data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'phone_model.create',
        entityType: 'PhoneModel',
        entityId: model.id,
        metadata: { slug: model.slug, brandId: model.brandId },
      });
      return model;
    } catch (error) {
      this.rethrow(error, dto.slug);
      throw error;
    }
  }

  async findAllForAdmin(brandId?: string): Promise<PhoneModelWithBrand[]> {
    return this.prisma.phoneModel.findMany({
      where: brandId ? { brandId } : undefined,
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
      ...PHONE_MODEL_WITH_BRAND,
    });
  }

  async findAllActive(brandId?: string): Promise<PhoneModelWithBrand[]> {
    return this.prisma.phoneModel.findMany({
      where: { isActive: true, ...(brandId ? { brandId } : {}) },
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
      ...PHONE_MODEL_WITH_BRAND,
    });
  }

  async findByIdOrThrow(id: string): Promise<PhoneModel> {
    const model = await this.prisma.phoneModel.findUnique({ where: { id } });
    if (!model) {
      throw new ResourceNotFoundException('PhoneModel', id);
    }
    return model;
  }

  async update(
    id: string,
    dto: UpdatePhoneModelDto,
    actor: AuthenticatedStaff,
  ): Promise<PhoneModel> {
    await this.findByIdOrThrow(id);
    try {
      const model = await this.prisma.phoneModel.update({ where: { id }, data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'phone_model.update',
        entityType: 'PhoneModel',
        entityId: model.id,
        metadata: { changes: dto },
      });
      return model;
    } catch (error) {
      this.rethrow(error, dto.slug);
      throw error;
    }
  }

  private rethrow(error: unknown, slug: string | undefined): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002' && slug) {
        throw new DuplicateResourceException(
          'PHONE_MODEL_SLUG_TAKEN',
          `A phone model with slug "${slug}" already exists`,
        );
      }
      if (error.code === 'P2003') {
        throw new ResourceNotFoundException('PhoneBrand', 'referenced brandId');
      }
    }
  }
}
