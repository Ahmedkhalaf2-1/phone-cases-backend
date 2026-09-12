import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface RecordAuditEntryInput {
  staffUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditEntryInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          staffUserId: input.staffUserId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          ipAddress: input.ipAddress ?? null,
        },
      });
    } catch (error) {
      // Audit logging must never break the primary operation it is
      // attached to - log the failure loudly instead of throwing.
      this.logger.error(
        'Failed to write audit log entry',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
