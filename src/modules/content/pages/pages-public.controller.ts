import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LocaleQueryDto } from '../../../common/dto/locale-query.dto';
import { DEFAULT_LOCALE, pickLocalized } from '../../../common/i18n/localized-field';
import { PagesService } from './pages.service';

@ApiTags('pages')
@Controller('pages')
export class PagesPublicController {
  constructor(private readonly service: PagesService) {}

  @Get()
  async findAll(@Query() query: LocaleQueryDto) {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const pages = await this.service.findAllPublished();
    return pages.map((page) => ({
      slug: page.slug,
      title: pickLocalized(page.titleEn, page.titleAr, locale),
    }));
  }

  @Get(':slug')
  async findOne(@Param('slug') slug: string, @Query() query: LocaleQueryDto) {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const page = await this.service.findPublishedBySlugOrThrow(slug);
    return {
      slug: page.slug,
      title: pickLocalized(page.titleEn, page.titleAr, locale),
      body: pickLocalized(page.bodyEn, page.bodyAr, locale),
      publishedAt: page.publishedAt,
    };
  }
}
