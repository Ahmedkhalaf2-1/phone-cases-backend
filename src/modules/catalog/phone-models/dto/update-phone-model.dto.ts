import { PartialType } from '@nestjs/swagger';
import { CreatePhoneModelDto } from './create-phone-model.dto';

export class UpdatePhoneModelDto extends PartialType(CreatePhoneModelDto) {}
