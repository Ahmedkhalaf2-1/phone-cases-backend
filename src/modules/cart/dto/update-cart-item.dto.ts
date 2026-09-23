import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_CART_ITEM_QUANTITY } from './add-cart-item.dto';

// See AddCartItemDto.note - same generous raw ceiling, real cap enforced
// post-trim by sanitizeCartItemNote.
const NOTE_RAW_MAX_LENGTH = 1000;

export class UpdateCartItemDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_CART_ITEM_QUANTITY,
    description: '0 removes the item from the cart',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CART_ITEM_QUANTITY)
  quantity?: number;

  @ApiPropertyOptional({
    maxLength: 500,
    nullable: true,
    description:
      'Free-text customization note for this line. Omit to leave unchanged, or send null to clear it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_RAW_MAX_LENGTH)
  note?: string | null;
}
