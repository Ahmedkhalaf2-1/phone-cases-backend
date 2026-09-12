import { PartialType } from '@nestjs/swagger';
import { CreateShippingRateDto } from './create-shipping-rate.dto';

export class UpdateShippingRateDto extends PartialType(CreateShippingRateDto) {}
