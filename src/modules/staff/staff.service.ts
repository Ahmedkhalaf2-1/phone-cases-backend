import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, StaffUser } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../common/exceptions/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../auth/types/authenticated-staff.type';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

const BCRYPT_SALT_ROUNDS = 12;

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateStaffDto, actor: AuthenticatedStaff, ip?: string): Promise<StaffUser> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    try {
      const staff = await this.prisma.staffUser.create({
        data: {
          email: dto.email.toLowerCase(),
          fullName: dto.fullName,
          role: dto.role,
          passwordHash,
        },
      });

      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'staff.create',
        entityType: 'StaffUser',
        entityId: staff.id,
        metadata: { email: staff.email, role: staff.role },
        ipAddress: ip ?? null,
      });

      return staff;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceException(
          'STAFF_EMAIL_TAKEN',
          `A staff account with email "${dto.email}" already exists`,
        );
      }
      throw error;
    }
  }

  async findAll(): Promise<StaffUser[]> {
    return this.prisma.staffUser.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async findById(id: string): Promise<StaffUser> {
    const staff = await this.prisma.staffUser.findUnique({ where: { id } });
    if (!staff) {
      throw new ResourceNotFoundException('Staff user', id);
    }
    return staff;
  }

  async update(
    id: string,
    dto: UpdateStaffDto,
    actor: AuthenticatedStaff,
    ip?: string,
  ): Promise<StaffUser> {
    const existing = await this.findById(id);

    if (existing.id === actor.id && dto.isActive === false) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    if (existing.id === actor.id && dto.role && dto.role !== existing.role) {
      throw new BadRequestException('You cannot change your own role');
    }

    const staff = await this.prisma.staffUser.update({
      where: { id },
      data: {
        fullName: dto.fullName,
        role: dto.role,
        isActive: dto.isActive,
      },
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'staff.update',
      entityType: 'StaffUser',
      entityId: staff.id,
      metadata: { changes: dto },
      ipAddress: ip ?? null,
    });

    return staff;
  }
}
