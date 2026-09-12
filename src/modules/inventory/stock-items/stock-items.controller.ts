import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentStaff } from '../../../common/decorators/current-staff.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { AdjustStockItemDto } from './dto/adjust-stock-item.dto';
import { CreateStockItemDto } from './dto/create-stock-item.dto';
import { StockItemsService } from './stock-items.service';

@ApiTags('admin/stock-items')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/stock-items')
export class StockItemsController {
  constructor(private readonly stockItemsService: StockItemsService) {}

  @Post()
  create(@Body() dto: CreateStockItemDto, @CurrentStaff() actor: AuthenticatedStaff) {
    return this.stockItemsService.create(dto, actor);
  }

  @Get()
  findAll() {
    return this.stockItemsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.stockItemsService.findByIdOrThrow(id);
  }

  @Patch(':id/adjust')
  adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustStockItemDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.stockItemsService.adjust(id, dto, actor);
  }

  @Get(':id/movements')
  findMovements(@Param('id', ParseUUIDPipe) id: string) {
    return this.stockItemsService.findMovements(id);
  }

  @Get(':id/reservations')
  findReservations(@Param('id', ParseUUIDPipe) id: string) {
    return this.stockItemsService.findReservations(id);
  }
}
