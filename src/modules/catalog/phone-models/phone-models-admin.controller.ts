import {
  Body,
  Controller,
  Get,
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
import { CreatePhoneModelDto } from './dto/create-phone-model.dto';
import { UpdatePhoneModelDto } from './dto/update-phone-model.dto';
import { PhoneModelsService } from './phone-models.service';

@ApiTags('admin/phone-models')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/phone-models')
export class PhoneModelsAdminController {
  constructor(private readonly service: PhoneModelsService) {}

  @Post()
  create(@Body() dto: CreatePhoneModelDto, @CurrentStaff() actor: AuthenticatedStaff) {
    return this.service.create(dto, actor);
  }

  @Get()
  findAll(@Query('brandId') brandId?: string) {
    return this.service.findAllForAdmin(brandId);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findByIdOrThrow(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePhoneModelDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.service.update(id, dto, actor);
  }
}
