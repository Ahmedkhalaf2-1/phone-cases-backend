import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';
import { SLUG_PATTERN } from '../../../catalog/phone-brands/dto/create-phone-brand.dto';

export class CreatePageDto {
  @ApiProperty({ example: 'shipping-policy' })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase kebab-case' })
  slug!: string;

  @ApiProperty({ example: 'Shipping Policy' })
  @IsString()
  @MinLength(1)
  titleEn!: string;

  @ApiProperty({ example: 'سياسة الشحن' })
  @IsString()
  @MinLength(1)
  titleAr!: string;

  @ApiProperty({ description: 'Full page body. Plain text/markdown, rendered by the frontend.' })
  @IsString()
  @MinLength(1)
  bodyEn!: string;

  @ApiProperty({ description: 'Full page body. Plain text/markdown, rendered by the frontend.' })
  @IsString()
  @MinLength(1)
  bodyAr!: string;
}
