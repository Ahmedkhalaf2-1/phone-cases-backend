import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class UploadCustomDesignDto {
  @ApiProperty({
    description: 'The purchasable, personalization-enabled ProductVariant this design is for.',
  })
  @IsUUID()
  variantId!: string;
}
