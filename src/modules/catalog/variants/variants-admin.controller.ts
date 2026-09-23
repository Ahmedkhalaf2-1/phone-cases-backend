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
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentStaff } from '../../../common/decorators/current-staff.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { UpsertPrintSpecDto } from './dto/upsert-print-spec.dto';
import { VariantsService } from './variants.service';

@ApiTags('admin/products/variants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/products/:productId/variants')
export class VariantsAdminController {
  constructor(private readonly variantsService: VariantsService) {}

  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateVariantDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.variantsService.create(productId, dto, actor);
  }

  @Get()
  findAll(@Param('productId', ParseUUIDPipe) productId: string) {
    return this.variantsService.findAllForProduct(productId);
  }

  @Get(':variantId')
  findOne(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ) {
    return this.variantsService.findOneForProduct(productId, variantId);
  }

  @Patch(':variantId')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.variantsService.update(productId, variantId, dto, actor);
  }

  // Optional per-variant print canvas override - see PrintSpecification in
  // prisma/schema.prisma. A personalizable variant works out of the box
  // with no call to this at all (DEFAULT_PRINT_SPEC).
  @Put(':variantId/print-spec')
  upsertPrintSpec(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpsertPrintSpecDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.variantsService.upsertPrintSpec(productId, variantId, dto, actor);
  }

  @Delete(':variantId/print-spec')
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePrintSpec(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.variantsService.deletePrintSpec(productId, variantId, actor);
  }
}
