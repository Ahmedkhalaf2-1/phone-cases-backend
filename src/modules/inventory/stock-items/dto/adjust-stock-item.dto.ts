import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MinLength } from 'class-validator';

export class AdjustStockItemDto {
  @ApiProperty({ description: 'Signed delta to apply to onHand, e.g. 10 or -3' })
  @IsInt()
  delta!: number;

  @ApiProperty({
    description: 'Free-text reason recorded in the audit log, e.g. "physical recount"',
  })
  @IsString()
  @MinLength(2)
  reason!: string;
}
