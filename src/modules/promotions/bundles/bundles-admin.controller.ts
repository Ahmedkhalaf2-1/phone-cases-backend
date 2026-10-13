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
import { BundleVariantIdsQueryDto } from './dto/bundle-variant-ids-query.dto';
import { BundleVariantOptionsQueryDto } from './dto/bundle-variant-options-query.dto';
import { BundlesService } from './bundles.service';
import { CreateBundleDto } from './dto/create-bundle.dto';
import { UpdateBundleDto } from './dto/update-bundle.dto';

@ApiTags('admin/bundles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/bundles')
export class BundlesAdminController {
  constructor(private readonly service: BundlesService) {}

  @Post()
  create(@Body() dto: CreateBundleDto, @CurrentStaff() actor: AuthenticatedStaff) {
    return this.service.create(dto, actor);
  }

  // Declared before ':id' so "variant-options" is never parsed as a bundle id.
  @Get('variant-options')
  variantOptions(@Query() query: BundleVariantOptionsQueryDto) {
    return this.service.listVariantOptions(query);
  }

  @Get('variant-options/ids')
  variantOptionIds(@Query() query: BundleVariantOptionsQueryDto) {
    return this.service.listVariantOptionIds(query);
  }

  @Get('variant-options/by-ids')
  variantsByIds(@Query() query: BundleVariantIdsQueryDto) {
    return this.service.listVariantsByIds(query.ids);
  }

  @Get()
  findAll() {
    return this.service.findAllForAdmin();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findByIdOrThrow(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBundleDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.service.update(id, dto, actor);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentStaff() actor: AuthenticatedStaff) {
    return this.service.delete(id, actor);
  }
}
