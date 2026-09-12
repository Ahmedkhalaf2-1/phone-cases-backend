import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';

export class CheckoutQuoteDto {
  @ApiProperty({ example: 'EG', description: '2-letter ISO 3166-1 country code' })
  @Matches(/^[A-Za-z]{2}$/, { message: 'country must be a 2-letter ISO code' })
  country!: string;

  @ApiProperty({
    description: 'A shipping rate id returned by GET /shipping-options for this country',
  })
  @IsUUID()
  shippingRateId!: string;
}
