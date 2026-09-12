import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * `@Type(() => Boolean)` looks like the right tool for a query-string
 * boolean, but it isn't: class-transformer applies it by calling the
 * `Boolean(...)` constructor on the raw string, and `Boolean("false")` is
 * `true` in JavaScript (any non-empty string is truthy) - so
 * `?availableOnly=false` was silently being read as `true`.
 *
 * A plain `@Transform` alone does not fix this: with the global
 * ValidationPipe's `enableImplicitConversion: true` (see main.ts), class-
 * transformer's own implicit type coercion (driven by this property's
 * reflected `boolean` type) runs BEFORE a custom `@Transform` callback
 * ever sees the value - so by the time this function receives `value`,
 * "false" has *already* been coerced to `true`, and there is no way to
 * recover the original string from it. Reading `obj[key]` instead - the
 * untouched source object class-transformer is converting FROM - bypasses
 * that already-corrupted intermediate value entirely.
 */
function parseBooleanQueryParam({
  obj,
  key,
}: {
  obj: Record<string, unknown>;
  key: string;
}): unknown {
  const raw = obj[key];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}
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
  @Transform(parseBooleanQueryParam)
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
