import { Injectable } from '@nestjs/common';
import { HomepageSection } from '@prisma/client';
import { ResourceNotFoundException } from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreateHomepageSectionDto } from './dto/create-homepage-section.dto';
import { UpdateHomepageSectionDto } from './dto/update-homepage-section.dto';

@Injectable()
export class HomepageSectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateHomepageSectionDto, actor: AuthenticatedStaff): Promise<HomepageSection> {
    if (dto.mediaAssetId) {
      await this.assertMediaExists(dto.mediaAssetId);
    }
    const section = await this.prisma.homepageSection.create({ data: dto });
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'homepage_section.create',
      entityType: 'HomepageSection',
      entityId: section.id,
    });
    return section;
  }

  findAllForAdmin(): Promise<HomepageSection[]> {
    return this.prisma.homepageSection.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  findAllEnabledWithMedia() {
    return this.prisma.homepageSection.findMany({
      where: { isEnabled: true },
      include: { mediaAsset: true },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findByIdOrThrow(id: string): Promise<HomepageSection> {
    const section = await this.prisma.homepageSection.findUnique({ where: { id } });
    if (!section) {
      throw new ResourceNotFoundException('HomepageSection', id);
    }
    return section;
  }

  async update(
    id: string,
    dto: UpdateHomepageSectionDto,
    actor: AuthenticatedStaff,
  ): Promise<HomepageSection> {
    await this.findByIdOrThrow(id);
    if (dto.mediaAssetId) {
      await this.assertMediaExists(dto.mediaAssetId);
    }
    const section = await this.prisma.homepageSection.update({ where: { id }, data: dto });
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'homepage_section.update',
      entityType: 'HomepageSection',
      entityId: section.id,
      metadata: { changes: dto },
    });
    return section;
  }

  async delete(id: string, actor: AuthenticatedStaff): Promise<void> {
    await this.findByIdOrThrow(id);
    await this.prisma.homepageSection.delete({ where: { id } });
    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'homepage_section.delete',
      entityType: 'HomepageSection',
      entityId: id,
    });
  }

  private async assertMediaExists(mediaAssetId: string): Promise<void> {
    const media = await this.prisma.mediaAsset.findUnique({ where: { id: mediaAssetId } });
    if (!media) {
      throw new ResourceNotFoundException('MediaAsset', mediaAssetId);
    }
  }
}
