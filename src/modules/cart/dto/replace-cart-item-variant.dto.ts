import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ReplaceCartItemVariantDto {
  @ApiProperty({ description: 'The variant to switch this cart line to' })
  @IsUUID()
  newVariantId!: string;
}
