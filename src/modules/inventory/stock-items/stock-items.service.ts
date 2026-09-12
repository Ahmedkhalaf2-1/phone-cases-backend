import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, StockItem, StockMovement, StockReservation } from '@prisma/client';
import {
  DuplicateResourceException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { ReservationsService } from '../reservations/reservations.service';
import { AdjustStockItemDto } from './dto/adjust-stock-item.dto';
import { CreateStockItemDto } from './dto/create-stock-item.dto';

@Injectable()
export class StockItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly reservationsService: ReservationsService,
  ) {}

  async create(dto: CreateStockItemDto, actor: AuthenticatedStaff): Promise<StockItem> {
    try {
      const stockItem = await this.prisma.stockItem.create({
        data: { sku: dto.sku, nameEn: dto.nameEn, nameAr: dto.nameAr, onHand: dto.onHand ?? 0 },
      });
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'stock_item.create',
        entityType: 'StockItem',
        entityId: stockItem.id,
        metadata: { sku: stockItem.sku, onHand: stockItem.onHand },
      });
      return stockItem;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceException(
          'STOCK_ITEM_SKU_TAKEN',
          `A stock item with SKU "${dto.sku}" already exists`,
        );
      }
      throw error;
    }
  }

  async findAll(): Promise<StockItem[]> {
    return this.prisma.stockItem.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findByIdOrThrow(id: string): Promise<StockItem> {
    const stockItem = await this.prisma.stockItem.findUnique({ where: { id } });
    if (!stockItem) {
      throw new ResourceNotFoundException('StockItem', id);
    }
    return stockItem;
  }

  /**
   * Applies a signed delta to onHand using a single conditional UPDATE so
   * concurrent adjustments can never drive the counter negative - a
   * read-then-write check alone would not be safe here. Records a
   * StockMovement in the same transaction so every onHand change (manual
   * or, from Phase 2 on, reservation consumption) has a durable reason
   * and reference trail.
   */
  async adjust(id: string, dto: AdjustStockItemDto, actor: AuthenticatedStaff): Promise<StockItem> {
    await this.findByIdOrThrow(id);

    // Column names are camelCase (Prisma's default mapping - no @map
    // directives were added on individual fields, only @@map on the
    // table), so they must stay double-quoted here to match exactly.
    const updated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<StockItem[]>(Prisma.sql`
        UPDATE stock_items
        SET "onHand" = "onHand" + ${dto.delta}, "updatedAt" = now()
        WHERE id = ${id} AND "onHand" + ${dto.delta} >= 0
        RETURNING id, sku, "nameEn", "nameAr", "onHand", reserved, "createdAt", "updatedAt";
      `);

      if (rows.length === 0) {
        return null;
      }

      await tx.stockMovement.create({
        data: {
          stockItemId: id,
          delta: dto.delta,
          reason: 'manual_adjustment',
          staffUserId: actor.id,
        },
      });

      return rows[0];
    });

    if (!updated) {
      throw new BadRequestException('Adjustment would make onHand negative');
    }

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'stock_item.adjust',
      entityType: 'StockItem',
      entityId: id,
      metadata: { delta: dto.delta, reason: dto.reason },
    });

    return updated;
  }

  async findMovements(stockItemId: string): Promise<StockMovement[]> {
    await this.findByIdOrThrow(stockItemId);
    return this.prisma.stockMovement.findMany({
      where: { stockItemId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findReservations(stockItemId: string): Promise<StockReservation[]> {
    await this.findByIdOrThrow(stockItemId);
    return this.reservationsService.findForStockItem(stockItemId);
  }
}
