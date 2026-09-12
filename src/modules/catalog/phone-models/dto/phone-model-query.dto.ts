import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { LocaleQueryDto } from '../../../../common/dto/locale-query.dto';

export class PhoneModelQueryDto extends LocaleQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  brandId?: string;
}
