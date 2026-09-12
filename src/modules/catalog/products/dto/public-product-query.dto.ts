import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Locale } from '../../../../common/i18n/localized-field';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';

export enum ProductSort {
  NEWEST = 'newest',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
}

export class PublicProductQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  collection?: string;

  @ApiPropertyOptional({ description: 'Phone model slug, e.g. "iphone-15"' })
  @IsOptional()
  @IsString()
  phoneModel?: string;

  @ApiPropertyOptional({ description: 'Case type slug, e.g. "shock-resistant"' })
  @IsOptional()
  @IsString()
  caseType?: string;

  @ApiPropertyOptional({ description: 'Minimum price in integer minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMin?: number;

  @ApiPropertyOptional({ description: 'Maximum price in integer minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMax?: number;

  @ApiPropertyOptional({
    description: 'When true, only return products with at least one currently available variant',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  availableOnly?: boolean;

  @ApiPropertyOptional({
    description: 'Free-text search across English/Arabic name and description',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: ProductSort, default: ProductSort.NEWEST })
  @IsOptional()
  @IsIn(Object.values(ProductSort))
  sort?: ProductSort;

  @ApiPropertyOptional({ enum: ['en', 'ar'], default: 'en' })
  @IsOptional()
  @IsIn(['en', 'ar'])
  locale?: Locale;
}
