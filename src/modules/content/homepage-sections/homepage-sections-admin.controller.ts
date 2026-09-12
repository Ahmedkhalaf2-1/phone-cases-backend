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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { CurrentStaff } from '../../../common/decorators/current-staff.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreateHomepageSectionDto } from './dto/create-homepage-section.dto';
import { UpdateHomepageSectionDto } from './dto/update-homepage-section.dto';
import { HomepageSectionsService } from './homepage-sections.service';

@ApiTags('admin/homepage-sections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/homepage-sections')
export class HomepageSectionsAdminController {
  constructor(private readonly service: HomepageSectionsService) {}

  @Post()
  create(@Body() dto: CreateHomepageSectionDto, @CurrentStaff() actor: AuthenticatedStaff) {
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
    @Body() dto: UpdateHomepageSectionDto,
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
