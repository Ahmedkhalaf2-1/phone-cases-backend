import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AttachCollectionDto {
  @ApiProperty()
  @IsUUID()
  collectionId!: string;
}
