import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class CreateShippingRateDto {
  @ApiProperty({ example: 'Standard delivery' })
  @IsString()
  @MinLength(1)
  nameEn!: string;

  @ApiProperty({ example: 'توصيل عادي' })
  @IsString()
  @MinLength(1)
  nameAr!: string;

  @ApiProperty({
    description:
      'Integer minor units. Demo/development values only until priced by the business - see docs/DECISIONS.md.',
  })
  @IsInt()
  @Min(0)
  price!: number;

  @ApiPropertyOptional({
    description:
      'Minor units; this rate becomes free once the order total (see docs/BUSINESS_RULES.md for before/after-discount basis) reaches this amount',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  freeShippingThreshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedDaysMin?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedDaysMax?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
