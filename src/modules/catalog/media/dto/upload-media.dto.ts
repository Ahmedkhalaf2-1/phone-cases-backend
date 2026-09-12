import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UploadMediaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  altTextEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  altTextAr?: string;
}
