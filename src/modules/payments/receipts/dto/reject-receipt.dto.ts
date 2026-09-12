import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RejectReceiptDto {
  @ApiProperty({ description: 'Why this screenshot was rejected - shown to staff, not the guest' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
