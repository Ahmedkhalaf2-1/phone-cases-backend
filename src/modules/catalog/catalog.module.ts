import { Module } from '@nestjs/common';
import { CaseTypesModule } from './case-types/case-types.module';
import { CollectionsModule } from './collections/collections.module';
import { MediaModule } from './media/media.module';
import { PhoneBrandsModule } from './phone-brands/phone-brands.module';
import { PhoneModelsModule } from './phone-models/phone-models.module';
import { ProductsModule } from './products/products.module';
import { VariantsModule } from './variants/variants.module';

@Module({
  imports: [
    PhoneBrandsModule,
    PhoneModelsModule,
    CaseTypesModule,
    CollectionsModule,
    ProductsModule,
    VariantsModule,
    MediaModule,
  ],
})
export class CatalogModule {}
