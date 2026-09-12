import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole, StaffUser } from '@prisma/client';
import type { Request } from 'express';
import { CurrentStaff } from '../../common/decorators/current-staff.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import type { AuthenticatedStaff } from '../auth/types/authenticated-staff.type';
import { CreateStaffDto } from './dto/create-staff.dto';
import { StaffResponseDto } from './dto/staff-response.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { StaffService } from './staff.service';

function toResponse(staff: StaffUser): StaffResponseDto {
  return {
    id: staff.id,
    email: staff.email,
    fullName: staff.fullName,
    role: staff.role,
    isActive: staff.isActive,
    createdAt: staff.createdAt,
  };
}

@ApiTags('admin/staff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN)
@Controller('admin/staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Post()
  async create(
    @Body() dto: CreateStaffDto,
    @CurrentStaff() actor: AuthenticatedStaff,
    @Req() req: Request,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.create(dto, actor, req.ip);
    return toResponse(staff);
  }

  @Get()
  async findAll(): Promise<StaffResponseDto[]> {
    const staff = await this.staffService.findAll();
    return staff.map(toResponse);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<StaffResponseDto> {
    const staff = await this.staffService.findById(id);
    return toResponse(staff);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffDto,
    @CurrentStaff() actor: AuthenticatedStaff,
    @Req() req: Request,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.update(id, dto, actor, req.ip);
    return toResponse(staff);
  }
}
