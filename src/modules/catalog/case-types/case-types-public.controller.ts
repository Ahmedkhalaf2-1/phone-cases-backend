import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LocaleQueryDto } from '../../../common/dto/locale-query.dto';
import { DEFAULT_LOCALE, pickLocalized } from '../../../common/i18n/localized-field';
import { CaseTypesService } from './case-types.service';

@ApiTags('case-types')
@Controller('case-types')
export class CaseTypesPublicController {
  constructor(private readonly service: CaseTypesService) {}

  @Get()
  async findAll(@Query() query: LocaleQueryDto) {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const caseTypes = await this.service.findAllActive();
    return caseTypes.map((caseType) => ({
      id: caseType.id,
      slug: caseType.slug,
      name: pickLocalized(caseType.nameEn, caseType.nameAr, locale),
      description: caseType.descriptionEn
        ? pickLocalized(caseType.descriptionEn, caseType.descriptionAr, locale)
        : null,
    }));
  }
}
