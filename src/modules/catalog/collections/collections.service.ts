import { Injectable } from '@nestjs/common';
import { Collection, Prisma } from '@prisma/client';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateCollectionDto, actor: AuthenticatedStaff): Promise<Collection> {
    try {
      const collection = await this.prisma.collection.create({ data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'collection.create',
        entityType: 'Collection',
        entityId: collection.id,
        metadata: { slug: collection.slug },
      });
      return collection;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  async findAllForAdmin(): Promise<Collection[]> {
    return this.prisma.collection.findMany({
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
    });
  }

  async findAllActive(): Promise<Collection[]> {
    return this.prisma.collection.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
    });
  }

  async findByIdOrThrow(id: string): Promise<Collection> {
    const collection = await this.prisma.collection.findUnique({ where: { id } });
    if (!collection) {
      throw new ResourceNotFoundException('Collection', id);
    }
    return collection;
  }

  async findBySlugOrThrow(slug: string): Promise<Collection> {
    const collection = await this.prisma.collection.findUnique({ where: { slug } });
    if (!collection || !collection.isActive) {
      throw new ResourceNotFoundException('Collection', slug);
    }
    return collection;
  }

  async update(
    id: string,
    dto: UpdateCollectionDto,
    actor: AuthenticatedStaff,
  ): Promise<Collection> {
    await this.findByIdOrThrow(id);
    try {
      const collection = await this.prisma.collection.update({ where: { id }, data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'collection.update',
        entityType: 'Collection',
        entityId: collection.id,
        metadata: { changes: dto },
      });
      return collection;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  private rethrowIfDuplicateSlug(error: unknown, slug: string | undefined): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && slug) {
      throw new DuplicateResourceException(
        'COLLECTION_SLUG_TAKEN',
        `A collection with slug "${slug}" already exists`,
      );
    }
  }
}
