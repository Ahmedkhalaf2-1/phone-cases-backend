import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';

export class CreateVariantDto {
  @ApiProperty({ example: 'SPACE-IP15-SHOCK' })
  @IsString()
  @MinLength(2)
  sku!: string;

  @ApiPropertyOptional({
    description: 'Leave empty for accessories with no phone-model dependency',
  })
  @IsOptional()
  @IsUUID()
  phoneModelId?: string;

  @ApiPropertyOptional({ description: 'Leave empty for accessories with no case-type dependency' })
  @IsOptional()
  @IsUUID()
  caseTypeId?: string;

  @ApiProperty({ description: 'Effective selling price in integer minor units (e.g. piastres)' })
  @IsInt()
  @IsPositive()
  price!: number;

  @ApiPropertyOptional({
    description:
      'Genuine higher reference price in integer minor units, must be greater than price',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  compareAtPrice?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  stockItemId?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Explicit opt-in: this variant is purchasable with no stock limit even though it has no ' +
      'linked stockItemId (e.g. a plain accessory, or a made-to-order item). Defaults to false - ' +
      'a variant with neither stockItemId nor isUnlimitedStock:true is NOT purchasable. Cannot be ' +
      'true at the same time as stockItemId is set.',
  })
  @IsOptional()
  @IsBoolean()
  isUnlimitedStock?: boolean;
}
