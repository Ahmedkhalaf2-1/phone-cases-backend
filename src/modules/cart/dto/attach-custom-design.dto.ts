import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AttachCustomDesignDto {
  @ApiProperty({ description: 'A CustomDesign id returned by POST /cart/custom-designs.' })
  @IsUUID()
  customDesignId!: string;
}
