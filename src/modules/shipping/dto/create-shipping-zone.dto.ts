import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class CreateShippingZoneDto {
  @ApiProperty({ example: 'Egypt' })
  @IsString()
  @MinLength(1)
  nameEn!: string;

  @ApiProperty({ example: 'مصر' })
  @IsString()
  @MinLength(1)
  nameAr!: string;

  @ApiProperty({
    example: ['EG'],
    description: 'ISO 3166-1 alpha-2 country codes this zone covers',
  })
  // Case-insensitive on input - ShippingService normalizes to uppercase
  // before persisting (and all lookups compare against the normalized
  // form), so validation only needs to reject the wrong shape.
  @IsArray()
  @ArrayMinSize(1)
  @Matches(/^[A-Za-z]{2}$/, {
    each: true,
    message: 'each country must be a 2-letter ISO code',
  })
  countries!: string[];

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
