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
import { CurrentStaff } from '../../common/decorators/current-staff.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import type { AuthenticatedStaff } from '../auth/types/authenticated-staff.type';
import { CreateShippingRateDto } from './dto/create-shipping-rate.dto';
import { CreateShippingZoneDto } from './dto/create-shipping-zone.dto';
import { UpdateShippingRateDto } from './dto/update-shipping-rate.dto';
import { UpdateShippingZoneDto } from './dto/update-shipping-zone.dto';
import { ShippingService } from './shipping.service';

@ApiTags('admin/shipping')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER_ADMIN, StaffRole.CATALOG_MANAGER)
@Controller('admin/shipping-zones')
export class ShippingAdminController {
  constructor(private readonly shippingService: ShippingService) {}

  @Post()
  createZone(@Body() dto: CreateShippingZoneDto, @CurrentStaff() actor: AuthenticatedStaff) {
    return this.shippingService.createZone(dto, actor);
  }

  @Get()
  findAllZones() {
    return this.shippingService.findAllZones();
  }

  @Get(':zoneId')
  findZone(@Param('zoneId', ParseUUIDPipe) zoneId: string) {
    return this.shippingService.findZoneByIdOrThrow(zoneId);
  }

  @Patch(':zoneId')
  updateZone(
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Body() dto: UpdateShippingZoneDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.shippingService.updateZone(zoneId, dto, actor);
  }

  @Post(':zoneId/rates')
  createRate(
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Body() dto: CreateShippingRateDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.shippingService.createRate(zoneId, dto, actor);
  }

  @Get(':zoneId/rates')
  findRates(@Param('zoneId', ParseUUIDPipe) zoneId: string) {
    return this.shippingService.findRatesForZone(zoneId);
  }

  @Patch(':zoneId/rates/:rateId')
  updateRate(
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Param('rateId', ParseUUIDPipe) rateId: string,
    @Body() dto: UpdateShippingRateDto,
    @CurrentStaff() actor: AuthenticatedStaff,
  ) {
    return this.shippingService.updateRate(zoneId, rateId, dto, actor);
  }
}
