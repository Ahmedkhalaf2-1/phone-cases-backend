import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdatePaymentStatusDto {
  @ApiProperty({
    enum: PaymentStatus,
    description:
      'Manually recorded by staff (e.g. a confirmed bank transfer or cash payment). No payment gateway is integrated yet - see docs/DECISIONS.md.',
  })
  @IsEnum(PaymentStatus)
  status!: PaymentStatus;
}
