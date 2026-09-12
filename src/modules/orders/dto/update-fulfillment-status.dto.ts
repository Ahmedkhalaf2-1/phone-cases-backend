import { ApiProperty } from '@nestjs/swagger';
import { FulfillmentStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateFulfillmentStatusDto {
  @ApiProperty({ enum: FulfillmentStatus })
  @IsEnum(FulfillmentStatus)
  status!: FulfillmentStatus;
}
