import { ApiPropertyOptional } from '@nestjs/swagger';
import { HomepageSectionType } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateHomepageSectionDto {
  @ApiPropertyOptional({ enum: HomepageSectionType, default: HomepageSectionType.BANNER })
  @IsOptional()
  @IsEnum(HomepageSectionType)
  type?: HomepageSectionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  titleEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  titleAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  bodyEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  bodyAr?: string;

  @ApiPropertyOptional({ description: 'An already-uploaded MediaAsset id' })
  @IsOptional()
  @IsUUID()
  mediaAssetId?: string;

  @ApiPropertyOptional({
    description: 'Relative path the frontend should link to, e.g. "/collections/summer-2026"',
  })
  @IsOptional()
  @IsString()
  linkUrl?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'A section is never shown on the public homepage until a staff member explicitly enables it',
  })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder?: number;
}
