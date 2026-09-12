import { PartialType } from '@nestjs/swagger';
import { CreatePhoneBrandDto } from './create-phone-brand.dto';

export class UpdatePhoneBrandDto extends PartialType(CreatePhoneBrandDto) {}
