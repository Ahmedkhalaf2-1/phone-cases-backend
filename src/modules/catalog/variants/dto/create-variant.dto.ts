import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
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

  @ApiPropertyOptional({
    default: false,
    description:
      'Explicit opt-in: this variant supports the Personalized Phone Case feature (customer image ' +
      'upload, automatic center-crop+cover print file, mockup preview). Never inferred - see ' +
      'docs/DECISIONS.md.',
  })
  @IsOptional()
  @IsBoolean()
  isPersonalizable?: boolean;

  @ApiPropertyOptional({
    default: 0,
    description:
      'Additional charge (integer minor units, same currency as price) applied when a custom ' +
      'design is attached. Only meaningful while isPersonalizable is true.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  customizationPrice?: number;
}
