import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { MAX_CART_ITEM_QUANTITY } from './add-cart-item.dto';

export class UpdateCartItemDto {
  @ApiProperty({
    minimum: 0,
    maximum: MAX_CART_ITEM_QUANTITY,
    description: '0 removes the item from the cart',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_CART_ITEM_QUANTITY)
  quantity!: number;
}
