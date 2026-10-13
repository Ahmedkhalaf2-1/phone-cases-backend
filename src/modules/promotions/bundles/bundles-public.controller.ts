import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BundlesService, PublicBundleOffer } from './bundles.service';

/**
 * Read-only, unauthenticated description of the currently active bundle
 * offers, so the storefront can explain a deal before checkout. It carries
 * no ids, names or admin fields, and pricing never depends on it - the
 * cart/checkout/order totals are always computed by the server.
 */
@ApiTags('bundles')
@Controller('bundles')
export class BundlesPublicController {
  constructor(private readonly service: BundlesService) {}

  @Get('active')
  @Header('Cache-Control', 'public, max-age=30')
  active(): Promise<PublicBundleOffer[]> {
    return this.service.listPublicOffers();
  }
}
