import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BundleScope } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Upper bounds that keep admin input inside Postgres INTEGER and sane pricing loops. */
export const MAX_BUNDLE_SIZE = 50;
export const MAX_ELIGIBLE_VARIANTS = 1000;
/** Prisma Int is int32; stay well below it so money fields can never overflow into a 500. */
const MAX_MINOR_UNITS = 2_000_000_000;

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
  @Max(MAX_MINOR_UNITS)
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
  @Max(MAX_MINOR_UNITS)
  fixedTotal?: number;

  @ApiPropertyOptional({ example: 'EGP' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  currency?: string;

  @ApiPropertyOptional({
    default: 2,
    minimum: 2,
    maximum: MAX_BUNDLE_SIZE,
    description: 'How many eligible units make up one bundle ("any N for fixedTotal")',
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(MAX_BUNDLE_SIZE)
  bundleSize?: number;

  @ApiPropertyOptional({
    enum: BundleScope,
    default: BundleScope.SPECIFIC_VARIANTS,
    description:
      'Which units are eligible. ALL_PRODUCTS takes no ids; SPECIFIC_VARIANTS uses eligibleVariants; ' +
      'PRODUCTS/COLLECTIONS/CASE_TYPES/PHONE_BRANDS/PHONE_MODELS use targetIds. ' +
      'Any other combination is rejected.',
  })
  @IsOptional()
  @IsEnum(BundleScope)
  scope?: BundleScope;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Ids of the products/collections/case types/brands/models matching `scope` (target scopes only)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  targetIds?: string[];

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

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO-8601. null clears the date; omitted leaves it unchanged (PATCH).',
  })
  @IsOptional()
  @IsISO8601()
  startsAt?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO-8601, must be later than startsAt. null clears the date (PATCH).',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;

  @ApiPropertyOptional({ type: [BundleEligibleVariantInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(MAX_ELIGIBLE_VARIANTS)
  @ValidateNested({ each: true })
  @Type(() => BundleEligibleVariantInputDto)
  eligibleVariants?: BundleEligibleVariantInputDto[];
}
