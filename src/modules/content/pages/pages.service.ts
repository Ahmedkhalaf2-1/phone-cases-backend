import { Injectable } from '@nestjs/common';
import { Page, PageStatus, Prisma } from '@prisma/client';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';

@Injectable()
export class PagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreatePageDto, actor: AuthenticatedStaff): Promise<Page> {
    try {
      const page = await this.prisma.page.create({ data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'page.create',
        entityType: 'Page',
        entityId: page.id,
        metadata: { slug: page.slug },
      });
      return page;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  findAllForAdmin(): Promise<Page[]> {
    return this.prisma.page.findMany({ orderBy: { createdAt: 'desc' } });
  }

  findAllPublished(): Promise<Page[]> {
    return this.prisma.page.findMany({
      where: { status: PageStatus.PUBLISHED },
      orderBy: { titleEn: 'asc' },
    });
  }

  async findByIdOrThrow(id: string): Promise<Page> {
    const page = await this.prisma.page.findUnique({ where: { id } });
    if (!page) {
      throw new ResourceNotFoundException('Page', id);
    }
    return page;
  }

  async findPublishedBySlugOrThrow(slug: string): Promise<Page> {
    const page = await this.prisma.page.findUnique({ where: { slug } });
    if (!page || page.status !== PageStatus.PUBLISHED) {
      throw new ResourceNotFoundException('Page', slug);
    }
    return page;
  }

  async update(id: string, dto: UpdatePageDto, actor: AuthenticatedStaff): Promise<Page> {
    await this.findByIdOrThrow(id);
    try {
      const page = await this.prisma.page.update({ where: { id }, data: dto });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'page.update',
        entityType: 'Page',
        entityId: page.id,
        metadata: { changes: dto },
      });
      return page;
    } catch (error) {
      this.rethrowIfDuplicateSlug(error, dto.slug);
      throw error;
    }
  }

  async updateStatus(
    id: string,
    targetStatus: PageStatus,
    actor: AuthenticatedStaff,
  ): Promise<Page> {
    const page = await this.findByIdOrThrow(id);
    if (page.status === targetStatus) {
      return page;
    }

    // publishedAt records the FIRST time this page went live and is never
    // cleared on unpublish, so staff retain that history - only a
    // transition INTO PUBLISHED refreshes it.
    const updated = await this.prisma.page.update({
      where: { id },
      data: {
        status: targetStatus,
        publishedAt: targetStatus === PageStatus.PUBLISHED ? new Date() : page.publishedAt,
      },
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: `page.status.${targetStatus.toLowerCase()}`,
      entityType: 'Page',
      entityId: page.id,
      metadata: { from: page.status, to: targetStatus },
    });

    return updated;
  }

  private rethrowIfDuplicateSlug(error: unknown, slug: string | undefined): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && slug) {
      throw new DuplicateResourceException(
        'PAGE_SLUG_TAKEN',
        `A page with slug "${slug}" already exists`,
      );
    }
  }
}
