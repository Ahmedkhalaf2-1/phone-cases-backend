-- Additive only: existing bundle_promotions rows get showAnnouncementBanner =
-- false, so no existing bundle ever appears in the storefront announcement bar.
ALTER TABLE "bundle_promotions" ADD COLUMN     "showAnnouncementBanner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bannerText" TEXT,
ADD COLUMN     "bannerCtaLabel" TEXT;
