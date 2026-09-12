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
import { CreatePhoneBrandDto } from './dto/create-phone-brand.dto';
import { UpdatePhoneBrandDto } from './dto/update-phone-brand.dto';
import { PhoneBrandsService } from './phone-brands.service';

@ApiTags('admin/phone-brands')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/phone-brands')
export class PhoneBrandsAdminController {
  constructor(private readonly service: PhoneBrandsService) {}

  @Post()
  create(@Body() dto: CreatePhoneBrandDto, @CurrentStaff() actor: AuthenticatedStaff) {
    return this.service.create(dto, actor);
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
    @Body() dto: UpdatePhoneBrandDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.service.update(id, dto, actor);
  }
}
