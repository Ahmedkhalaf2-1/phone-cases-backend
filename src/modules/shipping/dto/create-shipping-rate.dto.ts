import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

/** Stay below Postgres INTEGER so oversized admin input is a clear 400, never a 500. */
export const MAX_SHIPPING_MINOR_UNITS = 2_000_000_000;
export const MAX_ESTIMATED_DAYS = 365;
export const MAX_DISPLAY_ORDER = 1_000_000;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateShippingRateDto {
  @ApiProperty({ example: 'Standard delivery' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  nameEn!: string;

  @ApiProperty({ example: 'توصيل عادي' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  nameAr!: string;

  @ApiProperty({
    description:
      'Integer minor units. Demo/development values only until priced by the business - see docs/DECISIONS.md.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_SHIPPING_MINOR_UNITS)
  price!: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'null clears it (PATCH). Minor units; this rate becomes free once the order total (see docs/BUSINESS_RULES.md for before/after-discount basis) reaches this amount',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(MAX_SHIPPING_MINOR_UNITS)
  freeShippingThreshold?: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Whole days; null clears it (PATCH)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_ESTIMATED_DAYS)
  estimatedDaysMin?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Whole days, not less than estimatedDaysMin; null clears it (PATCH)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_ESTIMATED_DAYS)
  estimatedDaysMax?: number | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(-MAX_DISPLAY_ORDER)
  @Max(MAX_DISPLAY_ORDER)
  displayOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
