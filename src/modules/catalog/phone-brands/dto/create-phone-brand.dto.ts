import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreatePhoneBrandDto {
  @ApiProperty({ example: 'apple' })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase kebab-case, e.g. "apple"' })
  slug!: string;

  @ApiProperty({ example: 'Apple' })
  @IsString()
  @MinLength(1)
  nameEn!: string;

  @ApiProperty({ example: 'ابل' })
  @IsString()
  @MinLength(1)
  nameAr!: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
