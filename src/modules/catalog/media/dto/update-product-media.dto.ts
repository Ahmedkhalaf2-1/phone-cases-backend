import { ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsInt, IsOptional, Min } from 'class-validator';

export class UpdateProductMediaDto {
  @ApiPropertyOptional({
    enum: [true],
    description: 'Only true is accepted: makes this the primary image and unsets any other.',
  })
  @IsOptional()
  @Equals(true)
  isPrimary?: true;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}
