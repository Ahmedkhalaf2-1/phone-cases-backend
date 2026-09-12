import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DEFAULT_LOCALE } from '../../../common/i18n/localized-field';
import { toPublicProductDetail, toPublicProductSummary } from './product-response.mapper';
import { PublicProductQueryDto } from './dto/public-product-query.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller('products')
export class ProductsPublicController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async findAll(@Query() query: PublicProductQueryDto) {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const result = await this.productsService.findPublicList(query);
    return {
      items: result.items.map((product) => toPublicProductSummary(product, locale)),
      meta: result.meta,
    };
  }

  @Get(':slug')
  async findOne(@Param('slug') slug: string, @Query('locale') locale?: 'en' | 'ar') {
    const product = await this.productsService.findPublicBySlug(slug);
    return toPublicProductDetail(product, locale ?? DEFAULT_LOCALE);
  }
}
