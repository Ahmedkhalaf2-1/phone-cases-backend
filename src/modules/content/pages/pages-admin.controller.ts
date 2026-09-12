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
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { UpdatePageStatusDto } from './dto/update-page-status.dto';
import { PagesService } from './pages.service';

@ApiTags('admin/pages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/pages')
export class PagesAdminController {
  constructor(private readonly service: PagesService) {}

  @Post()
  create(@Body() dto: CreatePageDto, @CurrentStaff() actor: AuthenticatedStaff) {
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
    @Body() dto: UpdatePageDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.service.update(id, dto, actor);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePageStatusDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.service.updateStatus(id, dto.status, actor);
  }
}
