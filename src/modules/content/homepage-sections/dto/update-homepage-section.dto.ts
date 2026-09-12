import { PartialType } from '@nestjs/swagger';
import { CreateHomepageSectionDto } from './create-homepage-section.dto';

export class UpdateHomepageSectionDto extends PartialType(CreateHomepageSectionDto) {}
