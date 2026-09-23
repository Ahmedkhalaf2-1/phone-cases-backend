import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const MAX_CART_ITEM_QUANTITY = 20;

// Generous raw ceiling so leading/trailing whitespace never causes a
// rejection before sanitizeCartItemNote trims it - the real, post-trim
// cap (CART_ITEM_NOTE_MAX_LENGTH) is enforced there, not here.
const NOTE_RAW_MAX_LENGTH = 1000;

export class AddCartItemDto {
  @ApiProperty()
  @IsUUID()
  variantId!: string;

  @ApiProperty({ minimum: 1, maximum: MAX_CART_ITEM_QUANTITY, default: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_CART_ITEM_QUANTITY)
  quantity!: number;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Free-text customization instructions for this line (e.g. "put the case in a black box").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_RAW_MAX_LENGTH)
  note?: string;

  @ApiPropertyOptional({
    description:
      'A CustomDesign id (from POST /cart/custom-designs) to attach immediately when the variant ' +
      'is personalizable. Optional - a personalized line can also be created without one and get a ' +
      'design attached afterwards via PUT /cart/items/:itemId/custom-design. Ignored (must not be ' +
      'sent) for a non-personalizable variant.',
  })
  @IsOptional()
  @IsUUID()
  customDesignId?: string;
}
