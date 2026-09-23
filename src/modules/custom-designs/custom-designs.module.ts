import { Module } from '@nestjs/common';
import { CustomDesignsAdminController } from './custom-designs-admin.controller';
import { CustomDesignsCartController } from './custom-designs-cart.controller';
import { CustomDesignsService } from './custom-designs.service';
import { ImageProcessingService } from './image-processing.service';
import { MockupService } from './mockup.service';
import { CustomDesignStorageModule } from './storage/custom-design-storage.module';

@Module({
  imports: [CustomDesignStorageModule],
  controllers: [CustomDesignsCartController, CustomDesignsAdminController],
  providers: [CustomDesignsService, ImageProcessingService, MockupService],
  exports: [CustomDesignsService],
})
export class CustomDesignsModule {}
