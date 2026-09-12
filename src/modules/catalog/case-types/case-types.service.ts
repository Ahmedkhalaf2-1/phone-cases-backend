import { Injectable } from '@nestjs/common';
import { CaseType, Prisma } from '@prisma/client';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreateCaseTypeDto } from './dto/create-case-type.dto';
import { UpdateCaseTypeDto } from './dto/update-case-type.dto';

@Injectable()
export class CaseTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateCaseTypeDto, actor: AuthenticatedStaff): Promise<CaseType> {
    try {
      const caseType = await this.prisma.caseType.create({ data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'case_type.create',
        entityType: 'CaseType',
        entityId: caseType.id,
        metadata: { slug: caseType.slug },
      });
      return caseType;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  async findAllForAdmin(): Promise<CaseType[]> {
    return this.prisma.caseType.findMany({ orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }] });
  }

  async findAllActive(): Promise<CaseType[]> {
    return this.prisma.caseType.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
    });
  }

  async findByIdOrThrow(id: string): Promise<CaseType> {
    const caseType = await this.prisma.caseType.findUnique({ where: { id } });
    if (!caseType) {
      throw new ResourceNotFoundException('CaseType', id);
    }
    return caseType;
  }

  async update(id: string, dto: UpdateCaseTypeDto, actor: AuthenticatedStaff): Promise<CaseType> {
    await this.findByIdOrThrow(id);
    try {
      const caseType = await this.prisma.caseType.update({ where: { id }, data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'case_type.update',
        entityType: 'CaseType',
        entityId: caseType.id,
        metadata: { changes: dto },
      });
      return caseType;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  private rethrowIfDuplicateSlug(error: unknown, slug: string | undefined): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && slug) {
      throw new DuplicateResourceException(
        'CASE_TYPE_SLUG_TAKEN',
        `A case type with slug "${slug}" already exists`,
      );
    }
  }
}
