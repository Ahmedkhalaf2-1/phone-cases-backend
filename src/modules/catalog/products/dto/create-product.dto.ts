import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsPositive, IsString, Matches, MinLength } from 'class-validator';
import { SLUG_PATTERN } from '../../phone-brands/dto/create-phone-brand.dto';

export class CreateProductDto {
  @ApiProperty({ example: 'space' })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase kebab-case, e.g. "space"' })
  slug!: string;

  @ApiProperty({ example: 'Space' })
  @IsString()
  @MinLength(1)
  nameEn!: string;

  @ApiProperty({ example: 'الفضاء' })
  @IsString()
  @MinLength(1)
  nameAr!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descriptionEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descriptionAr?: string;

  @ApiPropertyOptional({
    description:
      'Optional list-level reference price in integer minor units. Not purchasable by itself.',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  basePrice?: number;

  @ApiPropertyOptional({ description: 'Staff-only notes, never exposed to the public API' })
  @IsOptional()
  @IsString()
  internalNotes?: string;
}
