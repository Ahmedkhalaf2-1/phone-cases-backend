import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export const MAX_VARIANT_IDS_LOOKUP = 100;

export class BundleVariantIdsQueryDto {
  @ApiProperty({
    type: String,
    description: `Comma-separated variant ids (1-${MAX_VARIANT_IDS_LOOKUP})`,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VARIANT_IDS_LOOKUP)
  @IsUUID('all', { each: true })
  ids!: string[];
}
