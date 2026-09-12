import { ApiProperty } from '@nestjs/swagger';
import { PageStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdatePageStatusDto {
  @ApiProperty({ enum: PageStatus })
  @IsEnum(PageStatus)
  status!: PageStatus;
}
