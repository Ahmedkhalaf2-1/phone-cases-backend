import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class ReorderProductMediaDto {
  @ApiProperty({
    type: [String],
    description:
      'Every MediaAsset id attached to the product, in the desired order. displayOrder becomes ' +
      'the array index and the first id becomes the primary image.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  mediaAssetIds!: string[];
}
