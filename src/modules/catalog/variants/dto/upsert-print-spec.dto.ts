import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrintOutputFormat } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsPositive, Max, Min } from 'class-validator';

export class UpsertPrintSpecDto {
  @ApiProperty({ description: 'Print canvas width in pixels.' })
  @IsInt()
  @IsPositive()
  widthPx!: number;

  @ApiProperty({ description: 'Print canvas height in pixels.' })
  @IsInt()
  @IsPositive()
  heightPx!: number;

  @ApiPropertyOptional({ default: 300 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  dpi?: number;

  @ApiPropertyOptional({
    description: 'Informational safe-margin border in pixels, kept inside widthPx/heightPx.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  safeMarginPx?: number;

  @ApiPropertyOptional({ enum: PrintOutputFormat, default: PrintOutputFormat.JPEG })
  @IsOptional()
  @IsEnum(PrintOutputFormat)
  outputFormat?: PrintOutputFormat;

  @ApiPropertyOptional({ default: 92, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  outputQuality?: number;
}
