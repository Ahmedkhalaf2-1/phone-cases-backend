import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LocaleQueryDto } from '../../../common/dto/locale-query.dto';
import { DEFAULT_LOCALE, pickLocalized } from '../../../common/i18n/localized-field';
import { HomepageSectionsService } from './homepage-sections.service';

@ApiTags('homepage')
@Controller('homepage-sections')
export class HomepageSectionsPublicController {
  constructor(private readonly service: HomepageSectionsService) {}

  @Get()
  async findAll(@Query() query: LocaleQueryDto) {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const sections = await this.service.findAllEnabledWithMedia();
    return sections.map((section) => ({
      id: section.id,
      type: section.type,
      title: section.titleEn ? pickLocalized(section.titleEn, section.titleAr, locale) : null,
      body: section.bodyEn ? pickLocalized(section.bodyEn, section.bodyAr, locale) : null,
      linkUrl: section.linkUrl,
      displayOrder: section.displayOrder,
      media: section.mediaAsset
        ? {
            url: section.mediaAsset.url,
            altText: pickLocalized(
              section.mediaAsset.altTextEn ?? '',
              section.mediaAsset.altTextAr,
              locale,
            ),
          }
        : null,
    }));
  }
}
