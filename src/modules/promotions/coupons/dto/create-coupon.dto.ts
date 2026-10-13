import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CouponType } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Stay below Postgres INTEGER so oversized admin input is a clear 400, never a 500. */
const MAX_MINOR_UNITS = 2_000_000_000;
export const MAX_COUPON_USAGE_LIMIT = 1_000_000;

export class CreateCouponDto {
  @ApiProperty({ example: 'WELCOME10' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,32}$/, {
    message: 'code must be 3-32 characters of letters, digits, underscore or hyphen',
  })
  code!: string;

  @ApiProperty({ enum: CouponType })
  @IsEnum(CouponType)
  type!: CouponType;

  @ApiProperty({
    description: 'Minor units for FIXED, whole percentage points (1-100) for PERCENTAGE',
  })
  @IsInt()
  @IsPositive()
  @Max(MAX_MINOR_UNITS)
  value!: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Minor units; cart subtotal must reach this to apply. null clears it (PATCH).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  minSpend?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO-8601. null clears the date; omitted leaves it unchanged (PATCH).',
  })
  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO-8601, must be later than startsAt. null clears the date (PATCH).',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Total number of times this coupon may be applied. null clears it (PATCH).',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(MAX_COUPON_USAGE_LIMIT)
  usageLimit?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
