import { PartialType } from '@nestjs/swagger';
import { CreateCaseTypeDto } from './create-case-type.dto';

export class UpdateCaseTypeDto extends PartialType(CreateCaseTypeDto) {}
