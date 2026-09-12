import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DEFAULT_LOCALE, Locale, pickLocalized } from '../../common/i18n/localized-field';
import { ShippingService } from './shipping.service';

@ApiTags('shipping')
@Controller('shipping-options')
export class ShippingPublicController {
  constructor(private readonly shippingService: ShippingService) {}

  @Get()
  async findForCountry(@Query('country') country?: string, @Query('locale') locale?: Locale) {
    if (!country || !/^[A-Za-z]{2}$/.test(country)) {
      throw new BadRequestException('A 2-letter "country" query parameter is required');
    }
    const effectiveLocale = locale ?? DEFAULT_LOCALE;
    const rates = await this.shippingService.findActiveRatesForCountry(country);
    return rates.map((rate) => ({
      id: rate.id,
      name: pickLocalized(rate.nameEn, rate.nameAr, effectiveLocale),
      price: rate.price,
      currency: rate.currency,
      freeShippingThreshold: rate.freeShippingThreshold,
      estimatedDaysMin: rate.estimatedDaysMin,
      estimatedDaysMax: rate.estimatedDaysMax,
    }));
  }
}
