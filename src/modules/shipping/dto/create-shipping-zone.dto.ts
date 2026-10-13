import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

const MAX_DISPLAY_ORDER = 1_000_000;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateShippingZoneDto {
  @ApiProperty({ example: 'Egypt' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  nameEn!: string;

  @ApiProperty({ example: 'مصر' })
  @Transform(trim)
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
  @Min(-MAX_DISPLAY_ORDER)
  @Max(MAX_DISPLAY_ORDER)
  displayOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
