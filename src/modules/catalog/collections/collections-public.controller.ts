import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LocaleQueryDto } from '../../../common/dto/locale-query.dto';
import { DEFAULT_LOCALE, Locale, pickLocalized } from '../../../common/i18n/localized-field';
import { CollectionsService, CollectionWithCover } from './collections.service';

function toPublicCollection(collection: CollectionWithCover, locale: Locale) {
  const cover = collection.coverMediaAsset;
  return {
    id: collection.id,
    slug: collection.slug,
    name: pickLocalized(collection.nameEn, collection.nameAr, locale),
    description: collection.descriptionEn
      ? pickLocalized(collection.descriptionEn, collection.descriptionAr, locale)
      : null,
    coverImage: cover
      ? { url: cover.url, altText: pickLocalized(cover.altTextEn ?? '', cover.altTextAr, locale) }
      : null,
  };
}

@ApiTags('collections')
@Controller('collections')
export class CollectionsPublicController {
  constructor(private readonly service: CollectionsService) {}

  @Get()
  async findAll(@Query() query: LocaleQueryDto) {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const collections = await this.service.findAllActive();
    return collections.map((collection) => toPublicCollection(collection, locale));
  }

  @Get(':slug')
  async findOne(@Param('slug') slug: string, @Query() query: LocaleQueryDto) {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const collection = await this.service.findBySlugOrThrow(slug);
    return toPublicCollection(collection, locale);
  }
}
