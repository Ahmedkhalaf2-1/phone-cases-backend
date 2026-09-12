import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, MinLength } from 'class-validator';

export class CreateOrderItemReturnDto {
  @ApiProperty({ description: 'How many units of this line were physically returned' })
  @IsInt()
  @IsPositive()
  quantity!: number;

  @ApiProperty({ example: 'Customer returned 1 unit, unopened' })
  @IsString()
  @MinLength(2)
  reason!: string;
}
