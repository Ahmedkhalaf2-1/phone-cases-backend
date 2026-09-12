import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class BundleEligibleVariantInputDto {
  @ApiProperty()
  @IsUUID()
  variantId!: string;

  @ApiPropertyOptional({
    default: 0,
    description: 'Added on top of fixedTotal when this variant fills a slot',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  surchargeAmount?: number;
}

export class CreateBundleDto {
  @ApiProperty({ description: 'Internal admin label, never shown to customers' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({ description: 'Total price for one bundle instance, integer minor units' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  fixedTotal?: number;

  @ApiPropertyOptional({ example: 'EGP' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  currency?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  requireDifferentPhoneModels?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isRepeatable?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowCouponStacking?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Refused unless fixedTotal, currency, and a complete eligible-variant set are already configured',
  })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({ type: [BundleEligibleVariantInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => BundleEligibleVariantInputDto)
  eligibleVariants?: BundleEligibleVariantInputDto[];
}
