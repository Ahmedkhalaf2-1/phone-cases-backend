import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, MinLength } from 'class-validator';

export class CreateRefundDto {
  @ApiProperty({
    description: 'Refund amount in integer minor units - must match the order currency',
  })
  @IsInt()
  @IsPositive()
  amount!: number;

  @ApiProperty({ example: 'EGP' })
  @IsString()
  @MinLength(1)
  currency!: string;

  @ApiProperty({ example: 'Customer returned one unit - refunded via InstaPay transfer' })
  @IsString()
  @MinLength(2)
  reason!: string;

  @ApiProperty({
    description: 'Client-supplied idempotency key - a retry with the same key is a safe no-op',
  })
  @IsString()
  @MinLength(8)
  idempotencyKey!: string;
}
