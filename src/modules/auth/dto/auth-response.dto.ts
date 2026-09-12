import { ApiProperty } from '@nestjs/swagger';
import type { StaffRole } from '@prisma/client';

export class StaffSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ enum: ['OWNER_ADMIN', 'CATALOG_MANAGER', 'ORDER_OPERATOR'] })
  role!: StaffRole;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty()
  expiresIn!: string;

  @ApiProperty({ type: StaffSummaryDto })
  staff!: StaffSummaryDto;
}
