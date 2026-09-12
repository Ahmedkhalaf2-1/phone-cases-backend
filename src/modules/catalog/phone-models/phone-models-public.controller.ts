import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DEFAULT_LOCALE, pickLocalized } from '../../../common/i18n/localized-field';
import { PhoneModelQueryDto } from './dto/phone-model-query.dto';
import { PhoneModelsService } from './phone-models.service';

@ApiTags('phone-models')
@Controller('phone-models')
export class PhoneModelsPublicController {
  constructor(private readonly service: PhoneModelsService) {}

  @Get()
  async findAll(@Query() query: PhoneModelQueryDto) {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const models = await this.service.findAllActive(query.brandId);
    return models.map((model) => ({
      id: model.id,
      slug: model.slug,
      name: pickLocalized(model.nameEn, model.nameAr, locale),
      releaseYear: model.releaseYear,
      brand: {
        id: model.brand.id,
        slug: model.brand.slug,
        name: pickLocalized(model.brand.nameEn, model.brand.nameAr, locale),
      },
    }));
  }
}
