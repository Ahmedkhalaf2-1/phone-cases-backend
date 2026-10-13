import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';

/**
 * Filters for the admin bundle variant picker. Every filter is optional and
 * they combine with AND; `q` matches SKU, product name, phone model and
 * case type so an admin can type what they actually remember.
 */
export class BundleVariantOptionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Free-text search across SKU, product, phone model, case type',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  collectionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  caseTypeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  phoneBrandId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  phoneModelId?: string;
}
