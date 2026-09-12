import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// This endpoint is public and unauthenticated (guest checkout) and every
// field below is persisted permanently as part of an immutable order
// snapshot - an upper bound on each keeps an anonymous caller from storing
// arbitrarily large values (idempotencyKey is also uniquely indexed, so an
// unbounded value there would also bloat that index disproportionately).
export class CreateOrderDto {
  @ApiProperty({
    description:
      'Client-generated idempotency key. Retrying with the same key and the same request body returns the original order; the same key with a different body is rejected.',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  idempotencyKey!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  customerFullName!: string;

  @ApiPropertyOptional({ description: 'Optional - no integration currently requires it' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  customerEmail?: string;

  @ApiProperty({ example: '01012345678' })
  @IsString()
  @MinLength(6)
  @MaxLength(32)
  customerPhone!: string;

  @ApiProperty({ example: 'EG', description: '2-letter ISO 3166-1 country code' })
  @Matches(/^[A-Za-z]{2}$/, { message: 'shippingCountry must be a 2-letter ISO code' })
  shippingCountry!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  shippingCity!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  shippingAddressLine1!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  shippingAddressLine2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  shippingPostalCode?: string;

  @ApiProperty({
    description: 'A shipping rate id returned by GET /shipping-options for shippingCountry',
  })
  @IsUUID()
  shippingRateId!: string;

  @ApiProperty({
    description:
      'The payable total the customer last saw (from POST /checkout/quote). If the server-computed total no longer matches, the order is rejected with the new totals so the client can re-confirm.',
  })
  @IsInt()
  @Min(0)
  expectedTotal!: number;
}
