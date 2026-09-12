import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { SLUG_PATTERN } from '../../phone-brands/dto/create-phone-brand.dto';

export class CreatePhoneModelDto {
  @ApiProperty()
  @IsUUID()
  brandId!: string;

  @ApiProperty({ example: 'iphone-15' })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase kebab-case, e.g. "iphone-15"' })
  slug!: string;

  @ApiProperty({ example: 'iPhone 15' })
  @IsString()
  @MinLength(1)
  nameEn!: string;

  @ApiProperty({ example: 'آيفون 15' })
  @IsString()
  @MinLength(1)
  nameAr!: string;

  @ApiPropertyOptional({ example: 2023 })
  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  releaseYear?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
