import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateStockItemDto {
  @ApiProperty({ example: 'BLANK-CASE-IP15' })
  @IsString()
  @MinLength(2)
  sku!: string;

  @ApiProperty({ example: 'iPhone 15 blank case shell' })
  @IsString()
  @MinLength(1)
  nameEn!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameAr?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  onHand?: number;
}
