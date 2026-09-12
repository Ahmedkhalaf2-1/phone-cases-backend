import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentStaff } from '../../../common/decorators/current-staff.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { AdminProductQueryDto } from './dto/admin-product-query.dto';
import { AttachCollectionDto } from './dto/attach-collection.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateProductStatusDto } from './dto/update-product-status.dto';
import { ProductsService } from './products.service';

@ApiTags('admin/products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/products')
export class ProductsAdminController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  create(@Body() dto: CreateProductDto, @CurrentStaff() actor: AuthenticatedStaff) {
    return this.productsService.create(dto, actor);
  }

  @Get()
  findAll(@Query() query: AdminProductQueryDto) {
    return this.productsService.findAllForAdmin(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.productsService.findByIdForAdmin(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.productsService.update(id, dto, actor);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductStatusDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.productsService.transitionStatus(id, dto.status, actor);
  }

  @Post(':id/collections')
  attachCollection(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachCollectionDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.productsService.attachCollection(id, dto.collectionId, actor);
  }

  @Delete(':id/collections/:collectionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  detachCollection(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('collectionId', ParseUUIDPipe) collectionId: string,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.productsService.detachCollection(id, collectionId, actor);
  }
}
