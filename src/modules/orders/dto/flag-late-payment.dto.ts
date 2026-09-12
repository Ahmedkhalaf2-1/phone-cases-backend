import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class FlagLatePaymentDto {
  @ApiProperty({ description: 'Free-text note for manual reconciliation (e.g. bank reference)' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note!: string;
}
