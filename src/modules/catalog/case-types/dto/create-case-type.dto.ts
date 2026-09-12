import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { SLUG_PATTERN } from '../../phone-brands/dto/create-phone-brand.dto';

export class CreateCaseTypeDto {
  @ApiProperty({ example: 'shock-resistant' })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase kebab-case' })
  slug!: string;

  @ApiProperty({ example: 'Shock-Resistant' })
  @IsString()
  @MinLength(1)
  nameEn!: string;

  @ApiProperty({ example: 'مقاوم للصدمات' })
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

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
