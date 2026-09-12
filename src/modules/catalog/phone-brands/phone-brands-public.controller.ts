import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LocaleQueryDto } from '../../../common/dto/locale-query.dto';
import { DEFAULT_LOCALE, pickLocalized } from '../../../common/i18n/localized-field';
import { PhoneBrandsService } from './phone-brands.service';

@ApiTags('phone-brands')
@Controller('phone-brands')
export class PhoneBrandsPublicController {
  constructor(private readonly service: PhoneBrandsService) {}

  @Get()
  async findAll(@Query() query: LocaleQueryDto) {
    const brands = await this.service.findAllActive();
    return brands.map((brand) => ({
      id: brand.id,
      slug: brand.slug,
      name: pickLocalized(brand.nameEn, brand.nameAr, query.locale ?? DEFAULT_LOCALE),
    }));
  }
}
