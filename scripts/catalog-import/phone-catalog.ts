/**
 * Curated phone brand/model roster for the bulk catalog import - recent-
 * to-popular-older models per brand, per the import requirements. Upserted
 * by slug (same pattern as prisma/seed.ts) so re-running never duplicates
 * rows, and existing rows (e.g. the "apple"/"samsung"/"iphone-15" seed
 * data) are reused rather than recreated.
 */

export interface PhoneBrandSeed {
  slug: string;
  nameEn: string;
  nameAr: string;
  displayOrder: number;
}

export interface PhoneModelSeed {
  slug: string;
  brandSlug: string;
  nameEn: string;
  nameAr: string;
  releaseYear: number;
  displayOrder: number;
}

export const PHONE_BRANDS: PhoneBrandSeed[] = [
  { slug: 'apple', nameEn: 'Apple', nameAr: 'أبل', displayOrder: 1 },
  { slug: 'samsung', nameEn: 'Samsung', nameAr: 'سامسونج', displayOrder: 2 },
  { slug: 'xiaomi', nameEn: 'Xiaomi', nameAr: 'شاومي', displayOrder: 3 },
  { slug: 'redmi', nameEn: 'Redmi', nameAr: 'ريدمي', displayOrder: 4 },
  { slug: 'poco', nameEn: 'POCO', nameAr: 'بوكو', displayOrder: 5 },
  { slug: 'oppo', nameEn: 'Oppo', nameAr: 'أوبو', displayOrder: 6 },
  { slug: 'realme', nameEn: 'Realme', nameAr: 'ريلمي', displayOrder: 7 },
  { slug: 'huawei', nameEn: 'Huawei', nameAr: 'هواوي', displayOrder: 8 },
  { slug: 'honor', nameEn: 'Honor', nameAr: 'هونور', displayOrder: 9 },
  { slug: 'infinix', nameEn: 'Infinix', nameAr: 'إنفينكس', displayOrder: 10 },
];

export const PHONE_MODELS: PhoneModelSeed[] = [
  // --- Apple ---------------------------------------------------------
  { slug: 'iphone-11', brandSlug: 'apple', nameEn: 'iPhone 11', nameAr: 'آيفون 11', releaseYear: 2019, displayOrder: 1 },
  { slug: 'iphone-11-pro', brandSlug: 'apple', nameEn: 'iPhone 11 Pro', nameAr: 'آيفون 11 برو', releaseYear: 2019, displayOrder: 2 },
  { slug: 'iphone-11-pro-max', brandSlug: 'apple', nameEn: 'iPhone 11 Pro Max', nameAr: 'آيفون 11 برو ماكس', releaseYear: 2019, displayOrder: 3 },
  { slug: 'iphone-12', brandSlug: 'apple', nameEn: 'iPhone 12', nameAr: 'آيفون 12', releaseYear: 2020, displayOrder: 4 },
  { slug: 'iphone-12-mini', brandSlug: 'apple', nameEn: 'iPhone 12 Mini', nameAr: 'آيفون 12 ميني', releaseYear: 2020, displayOrder: 5 },
  { slug: 'iphone-12-pro', brandSlug: 'apple', nameEn: 'iPhone 12 Pro', nameAr: 'آيفون 12 برو', releaseYear: 2020, displayOrder: 6 },
  { slug: 'iphone-12-pro-max', brandSlug: 'apple', nameEn: 'iPhone 12 Pro Max', nameAr: 'آيفون 12 برو ماكس', releaseYear: 2020, displayOrder: 7 },
  { slug: 'iphone-13', brandSlug: 'apple', nameEn: 'iPhone 13', nameAr: 'آيفون 13', releaseYear: 2021, displayOrder: 8 },
  { slug: 'iphone-13-mini', brandSlug: 'apple', nameEn: 'iPhone 13 Mini', nameAr: 'آيفون 13 ميني', releaseYear: 2021, displayOrder: 9 },
  { slug: 'iphone-13-pro', brandSlug: 'apple', nameEn: 'iPhone 13 Pro', nameAr: 'آيفون 13 برو', releaseYear: 2021, displayOrder: 10 },
  { slug: 'iphone-13-pro-max', brandSlug: 'apple', nameEn: 'iPhone 13 Pro Max', nameAr: 'آيفون 13 برو ماكس', releaseYear: 2021, displayOrder: 11 },
  { slug: 'iphone-14', brandSlug: 'apple', nameEn: 'iPhone 14', nameAr: 'آيفون 14', releaseYear: 2022, displayOrder: 12 },
  { slug: 'iphone-14-plus', brandSlug: 'apple', nameEn: 'iPhone 14 Plus', nameAr: 'آيفون 14 بلس', releaseYear: 2022, displayOrder: 13 },
  { slug: 'iphone-14-pro', brandSlug: 'apple', nameEn: 'iPhone 14 Pro', nameAr: 'آيفون 14 برو', releaseYear: 2022, displayOrder: 14 },
  { slug: 'iphone-14-pro-max', brandSlug: 'apple', nameEn: 'iPhone 14 Pro Max', nameAr: 'آيفون 14 برو ماكس', releaseYear: 2022, displayOrder: 15 },
  { slug: 'iphone-15', brandSlug: 'apple', nameEn: 'iPhone 15', nameAr: 'آيفون 15', releaseYear: 2023, displayOrder: 16 },
  { slug: 'iphone-15-plus', brandSlug: 'apple', nameEn: 'iPhone 15 Plus', nameAr: 'آيفون 15 بلس', releaseYear: 2023, displayOrder: 17 },
  { slug: 'iphone-15-pro', brandSlug: 'apple', nameEn: 'iPhone 15 Pro', nameAr: 'آيفون 15 برو', releaseYear: 2023, displayOrder: 18 },
  { slug: 'iphone-15-pro-max', brandSlug: 'apple', nameEn: 'iPhone 15 Pro Max', nameAr: 'آيفون 15 برو ماكس', releaseYear: 2023, displayOrder: 19 },
  { slug: 'iphone-16', brandSlug: 'apple', nameEn: 'iPhone 16', nameAr: 'آيفون 16', releaseYear: 2024, displayOrder: 20 },
  { slug: 'iphone-16-plus', brandSlug: 'apple', nameEn: 'iPhone 16 Plus', nameAr: 'آيفون 16 بلس', releaseYear: 2024, displayOrder: 21 },
  { slug: 'iphone-16-pro', brandSlug: 'apple', nameEn: 'iPhone 16 Pro', nameAr: 'آيفون 16 برو', releaseYear: 2024, displayOrder: 22 },
  { slug: 'iphone-16-pro-max', brandSlug: 'apple', nameEn: 'iPhone 16 Pro Max', nameAr: 'آيفون 16 برو ماكس', releaseYear: 2024, displayOrder: 23 },
  { slug: 'iphone-16e', brandSlug: 'apple', nameEn: 'iPhone 16e', nameAr: 'آيفون 16 إي', releaseYear: 2025, displayOrder: 24 },
  { slug: 'iphone-17', brandSlug: 'apple', nameEn: 'iPhone 17', nameAr: 'آيفون 17', releaseYear: 2025, displayOrder: 25 },
  { slug: 'iphone-air', brandSlug: 'apple', nameEn: 'iPhone Air', nameAr: 'آيفون إير', releaseYear: 2025, displayOrder: 26 },
  { slug: 'iphone-17-pro', brandSlug: 'apple', nameEn: 'iPhone 17 Pro', nameAr: 'آيفون 17 برو', releaseYear: 2025, displayOrder: 27 },
  { slug: 'iphone-17-pro-max', brandSlug: 'apple', nameEn: 'iPhone 17 Pro Max', nameAr: 'آيفون 17 برو ماكس', releaseYear: 2025, displayOrder: 28 },

  // --- Samsung ---------------------------------------------------------
  { slug: 'galaxy-s21', brandSlug: 'samsung', nameEn: 'Galaxy S21', nameAr: 'جالاكسي إس 21', releaseYear: 2021, displayOrder: 1 },
  { slug: 'galaxy-s21-plus', brandSlug: 'samsung', nameEn: 'Galaxy S21+', nameAr: 'جالاكسي إس 21 بلس', releaseYear: 2021, displayOrder: 2 },
  { slug: 'galaxy-s21-ultra', brandSlug: 'samsung', nameEn: 'Galaxy S21 Ultra', nameAr: 'جالاكسي إس 21 ألترا', releaseYear: 2021, displayOrder: 3 },
  { slug: 'galaxy-s22', brandSlug: 'samsung', nameEn: 'Galaxy S22', nameAr: 'جالاكسي إس 22', releaseYear: 2022, displayOrder: 4 },
  { slug: 'galaxy-s22-plus', brandSlug: 'samsung', nameEn: 'Galaxy S22+', nameAr: 'جالاكسي إس 22 بلس', releaseYear: 2022, displayOrder: 5 },
  { slug: 'galaxy-s22-ultra', brandSlug: 'samsung', nameEn: 'Galaxy S22 Ultra', nameAr: 'جالاكسي إس 22 ألترا', releaseYear: 2022, displayOrder: 6 },
  { slug: 'galaxy-s23', brandSlug: 'samsung', nameEn: 'Galaxy S23', nameAr: 'جالاكسي إس 23', releaseYear: 2023, displayOrder: 7 },
  { slug: 'galaxy-s23-plus', brandSlug: 'samsung', nameEn: 'Galaxy S23+', nameAr: 'جالاكسي إس 23 بلس', releaseYear: 2023, displayOrder: 8 },
  { slug: 'galaxy-s23-ultra', brandSlug: 'samsung', nameEn: 'Galaxy S23 Ultra', nameAr: 'جالاكسي إس 23 ألترا', releaseYear: 2023, displayOrder: 9 },
  { slug: 'galaxy-s24', brandSlug: 'samsung', nameEn: 'Galaxy S24', nameAr: 'جالاكسي إس 24', releaseYear: 2024, displayOrder: 10 },
  { slug: 'galaxy-s24-plus', brandSlug: 'samsung', nameEn: 'Galaxy S24+', nameAr: 'جالاكسي إس 24 بلس', releaseYear: 2024, displayOrder: 11 },
  { slug: 'galaxy-s24-ultra', brandSlug: 'samsung', nameEn: 'Galaxy S24 Ultra', nameAr: 'جالاكسي إس 24 ألترا', releaseYear: 2024, displayOrder: 12 },
  { slug: 'galaxy-s25', brandSlug: 'samsung', nameEn: 'Galaxy S25', nameAr: 'جالاكسي إس 25', releaseYear: 2025, displayOrder: 13 },
  { slug: 'galaxy-s25-plus', brandSlug: 'samsung', nameEn: 'Galaxy S25+', nameAr: 'جالاكسي إس 25 بلس', releaseYear: 2025, displayOrder: 14 },
  { slug: 'galaxy-s25-ultra', brandSlug: 'samsung', nameEn: 'Galaxy S25 Ultra', nameAr: 'جالاكسي إس 25 ألترا', releaseYear: 2025, displayOrder: 15 },
  { slug: 'galaxy-s25-edge', brandSlug: 'samsung', nameEn: 'Galaxy S25 Edge', nameAr: 'جالاكسي إس 25 إيدج', releaseYear: 2025, displayOrder: 16 },
  { slug: 'galaxy-a16', brandSlug: 'samsung', nameEn: 'Galaxy A16', nameAr: 'جالاكسي إيه 16', releaseYear: 2024, displayOrder: 17 },
  { slug: 'galaxy-a25', brandSlug: 'samsung', nameEn: 'Galaxy A25', nameAr: 'جالاكسي إيه 25', releaseYear: 2024, displayOrder: 18 },
  { slug: 'galaxy-a35', brandSlug: 'samsung', nameEn: 'Galaxy A35', nameAr: 'جالاكسي إيه 35', releaseYear: 2024, displayOrder: 19 },
  { slug: 'galaxy-a55', brandSlug: 'samsung', nameEn: 'Galaxy A55', nameAr: 'جالاكسي إيه 55', releaseYear: 2024, displayOrder: 20 },
  { slug: 'galaxy-a15', brandSlug: 'samsung', nameEn: 'Galaxy A15', nameAr: 'جالاكسي إيه 15', releaseYear: 2023, displayOrder: 21 },
  { slug: 'galaxy-a05', brandSlug: 'samsung', nameEn: 'Galaxy A05', nameAr: 'جالاكسي إيه 05', releaseYear: 2023, displayOrder: 22 },
  { slug: 'galaxy-z-fold4', brandSlug: 'samsung', nameEn: 'Galaxy Z Fold4', nameAr: 'جالاكسي زد فولد 4', releaseYear: 2022, displayOrder: 23 },
  { slug: 'galaxy-z-fold5', brandSlug: 'samsung', nameEn: 'Galaxy Z Fold5', nameAr: 'جالاكسي زد فولد 5', releaseYear: 2023, displayOrder: 24 },
  { slug: 'galaxy-z-fold6', brandSlug: 'samsung', nameEn: 'Galaxy Z Fold6', nameAr: 'جالاكسي زد فولد 6', releaseYear: 2024, displayOrder: 25 },
  { slug: 'galaxy-z-flip4', brandSlug: 'samsung', nameEn: 'Galaxy Z Flip4', nameAr: 'جالاكسي زد فليب 4', releaseYear: 2022, displayOrder: 26 },
  { slug: 'galaxy-z-flip5', brandSlug: 'samsung', nameEn: 'Galaxy Z Flip5', nameAr: 'جالاكسي زد فليب 5', releaseYear: 2023, displayOrder: 27 },
  { slug: 'galaxy-z-flip6', brandSlug: 'samsung', nameEn: 'Galaxy Z Flip6', nameAr: 'جالاكسي زد فليب 6', releaseYear: 2024, displayOrder: 28 },

  // --- Xiaomi ---------------------------------------------------------
  { slug: 'xiaomi-13', brandSlug: 'xiaomi', nameEn: 'Xiaomi 13', nameAr: 'شاومي 13', releaseYear: 2022, displayOrder: 1 },
  { slug: 'xiaomi-13t', brandSlug: 'xiaomi', nameEn: 'Xiaomi 13T', nameAr: 'شاومي 13 تي', releaseYear: 2023, displayOrder: 2 },
  { slug: 'xiaomi-14', brandSlug: 'xiaomi', nameEn: 'Xiaomi 14', nameAr: 'شاومي 14', releaseYear: 2023, displayOrder: 3 },
  { slug: 'xiaomi-14t', brandSlug: 'xiaomi', nameEn: 'Xiaomi 14T', nameAr: 'شاومي 14 تي', releaseYear: 2024, displayOrder: 4 },
  { slug: 'xiaomi-15', brandSlug: 'xiaomi', nameEn: 'Xiaomi 15', nameAr: 'شاومي 15', releaseYear: 2024, displayOrder: 5 },

  // --- Redmi ---------------------------------------------------------
  { slug: 'redmi-note-12', brandSlug: 'redmi', nameEn: 'Redmi Note 12', nameAr: 'ريدمي نوت 12', releaseYear: 2022, displayOrder: 1 },
  { slug: 'redmi-note-13', brandSlug: 'redmi', nameEn: 'Redmi Note 13', nameAr: 'ريدمي نوت 13', releaseYear: 2023, displayOrder: 2 },
  { slug: 'redmi-note-13-pro', brandSlug: 'redmi', nameEn: 'Redmi Note 13 Pro', nameAr: 'ريدمي نوت 13 برو', releaseYear: 2023, displayOrder: 3 },
  { slug: 'redmi-note-14', brandSlug: 'redmi', nameEn: 'Redmi Note 14', nameAr: 'ريدمي نوت 14', releaseYear: 2024, displayOrder: 4 },
  { slug: 'redmi-note-14-pro', brandSlug: 'redmi', nameEn: 'Redmi Note 14 Pro', nameAr: 'ريدمي نوت 14 برو', releaseYear: 2024, displayOrder: 5 },

  // --- POCO ---------------------------------------------------------
  { slug: 'poco-x6', brandSlug: 'poco', nameEn: 'POCO X6', nameAr: 'بوكو إكس 6', releaseYear: 2024, displayOrder: 1 },
  { slug: 'poco-x6-pro', brandSlug: 'poco', nameEn: 'POCO X6 Pro', nameAr: 'بوكو إكس 6 برو', releaseYear: 2024, displayOrder: 2 },
  { slug: 'poco-f6', brandSlug: 'poco', nameEn: 'POCO F6', nameAr: 'بوكو إف 6', releaseYear: 2024, displayOrder: 3 },
  { slug: 'poco-m6-pro', brandSlug: 'poco', nameEn: 'POCO M6 Pro', nameAr: 'بوكو إم 6 برو', releaseYear: 2024, displayOrder: 4 },

  // --- Oppo ---------------------------------------------------------
  { slug: 'oppo-reno-11', brandSlug: 'oppo', nameEn: 'Oppo Reno 11', nameAr: 'أوبو رينو 11', releaseYear: 2024, displayOrder: 1 },
  { slug: 'oppo-reno-12', brandSlug: 'oppo', nameEn: 'Oppo Reno 12', nameAr: 'أوبو رينو 12', releaseYear: 2024, displayOrder: 2 },
  { slug: 'oppo-a98', brandSlug: 'oppo', nameEn: 'Oppo A98', nameAr: 'أوبو A98', releaseYear: 2023, displayOrder: 3 },
  { slug: 'oppo-a78', brandSlug: 'oppo', nameEn: 'Oppo A78', nameAr: 'أوبو A78', releaseYear: 2023, displayOrder: 4 },
  { slug: 'oppo-find-x7', brandSlug: 'oppo', nameEn: 'Oppo Find X7', nameAr: 'أوبو فايند إكس 7', releaseYear: 2024, displayOrder: 5 },

  // --- Realme ---------------------------------------------------------
  { slug: 'realme-12', brandSlug: 'realme', nameEn: 'Realme 12', nameAr: 'ريلمي 12', releaseYear: 2024, displayOrder: 1 },
  { slug: 'realme-11', brandSlug: 'realme', nameEn: 'Realme 11', nameAr: 'ريلمي 11', releaseYear: 2023, displayOrder: 2 },
  { slug: 'realme-c67', brandSlug: 'realme', nameEn: 'Realme C67', nameAr: 'ريلمي C67', releaseYear: 2023, displayOrder: 3 },
  { slug: 'realme-gt-6', brandSlug: 'realme', nameEn: 'Realme GT 6', nameAr: 'ريلمي جي تي 6', releaseYear: 2024, displayOrder: 4 },
  { slug: 'realme-narzo-70', brandSlug: 'realme', nameEn: 'Realme Narzo 70', nameAr: 'ريلمي نارزو 70', releaseYear: 2024, displayOrder: 5 },

  // --- Huawei ---------------------------------------------------------
  { slug: 'huawei-nova-12', brandSlug: 'huawei', nameEn: 'Huawei Nova 12', nameAr: 'هواوي نوفا 12', releaseYear: 2023, displayOrder: 1 },
  { slug: 'huawei-nova-11', brandSlug: 'huawei', nameEn: 'Huawei Nova 11', nameAr: 'هواوي نوفا 11', releaseYear: 2023, displayOrder: 2 },
  { slug: 'huawei-p60', brandSlug: 'huawei', nameEn: 'Huawei P60', nameAr: 'هواوي بي 60', releaseYear: 2023, displayOrder: 3 },
  { slug: 'huawei-mate-60', brandSlug: 'huawei', nameEn: 'Huawei Mate 60', nameAr: 'هواوي ميت 60', releaseYear: 2023, displayOrder: 4 },
  { slug: 'huawei-y70', brandSlug: 'huawei', nameEn: 'Huawei Y70', nameAr: 'هواوي واي 70', releaseYear: 2023, displayOrder: 5 },

  // --- Honor ---------------------------------------------------------
  { slug: 'honor-x9b', brandSlug: 'honor', nameEn: 'Honor X9b', nameAr: 'هونور X9b', releaseYear: 2024, displayOrder: 1 },
  { slug: 'honor-90', brandSlug: 'honor', nameEn: 'Honor 90', nameAr: 'هونور 90', releaseYear: 2023, displayOrder: 2 },
  { slug: 'honor-magic6', brandSlug: 'honor', nameEn: 'Honor Magic6', nameAr: 'هونور ماجيك 6', releaseYear: 2024, displayOrder: 3 },
  { slug: 'honor-x8b', brandSlug: 'honor', nameEn: 'Honor X8b', nameAr: 'هونور X8b', releaseYear: 2024, displayOrder: 4 },
  { slug: 'honor-200', brandSlug: 'honor', nameEn: 'Honor 200', nameAr: 'هونور 200', releaseYear: 2024, displayOrder: 5 },

  // --- Infinix ---------------------------------------------------------
  { slug: 'infinix-note-40', brandSlug: 'infinix', nameEn: 'Infinix Note 40', nameAr: 'إنفينكس نوت 40', releaseYear: 2024, displayOrder: 1 },
  { slug: 'infinix-hot-40', brandSlug: 'infinix', nameEn: 'Infinix Hot 40', nameAr: 'إنفينكس هوت 40', releaseYear: 2023, displayOrder: 2 },
  { slug: 'infinix-zero-30', brandSlug: 'infinix', nameEn: 'Infinix Zero 30', nameAr: 'إنفينكس زيرو 30', releaseYear: 2023, displayOrder: 3 },
  { slug: 'infinix-smart-8', brandSlug: 'infinix', nameEn: 'Infinix Smart 8', nameAr: 'إنفينكس سمارت 8', releaseYear: 2023, displayOrder: 4 },
  { slug: 'infinix-note-30', brandSlug: 'infinix', nameEn: 'Infinix Note 30', nameAr: 'إنفينكس نوت 30', releaseYear: 2023, displayOrder: 5 },
];
