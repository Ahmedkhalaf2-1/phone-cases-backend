/**
 * Hand-authored classification for this one import batch (`photos/`).
 *
 * Every dedup survivor was viewed directly (not guessed by a script - see
 * the import plan) and assigned a clean product name/slug and the
 * collection(s) it genuinely belongs to. Keyed by the *chosen representative
 * file's original filename* - stable across re-runs as long as the source
 * folder isn't changed, since dedupeCandidates' selection (highest
 * resolution -> largest file size -> cleanest filename) is deterministic.
 *
 * A survivor with no entry here is reported as "uncategorized" and skipped
 * unless --allow-uncategorized is passed - see run.ts. This manifest does
 * NOT generalize to a different photos/ folder; a future batch needs its
 * own manifest built the same way.
 */

export interface DesignManifestEntry {
  slug: string;
  nameEn: string;
  nameAr: string;
  /** Collection slugs this product genuinely belongs to (can be empty). */
  collections: string[];
}

export const COLLECTIONS: Record<string, { nameEn: string; nameAr: string; descriptionEn: string; descriptionAr: string }> = {
  football: {
    nameEn: 'Football',
    nameAr: 'كرة القدم',
    descriptionEn: 'Club crests, players and fan-art designs for football fans.',
    descriptionAr: 'شعارات الأندية واللاعبين وتصاميم فنية لعشاق كرة القدم.',
  },
  quotes: {
    nameEn: 'Quotes',
    nameAr: 'اقتباسات',
    descriptionEn: 'Motivational lines and fan chants front and center.',
    descriptionAr: 'عبارات تحفيزية وهتافات جماهيرية في صدارة التصميم.',
  },
};

export const DESIGN_MANIFEST: Record<string, DesignManifestEntry> = {
  'imgi_107_MadridRoyaltyPhoneCase.jpg': {
    slug: 'madrid-royalty',
    nameEn: 'Real Madrid Royalty',
    nameAr: 'ريال مدريد الملكي',
    collections: ['football'],
  },
  'imgi_124_d9369755-09ef-4045-b123-ac1c165d48c9copy5.jpg': {
    slug: 'zamalek-20',
    nameEn: 'Zamalek SC No. 20',
    nameAr: 'الزمالك رقم 20',
    collections: ['football'],
  },
  'imgi_132_d9369755-09ef-4045-b123-ac1c165d48c9copy36.jpg': {
    slug: 'barcelona-mes-que-un-club',
    nameEn: 'Barcelona – Més Que Un Club',
    nameAr: 'برشلونة - أكثر من مجرد نادٍ',
    collections: ['football'],
  },
  'imgi_140_d9369755-09ef-4045-b123-ac1c165d48c9copy44.jpg': {
    slug: 'visca-barca',
    nameEn: 'Visca Barça Stripes',
    nameAr: 'فيسكا برشا',
    collections: ['football'],
  },
  'imgi_148_d9369755-09ef-4045-b123-ac1c165d48c9copy58.jpg': {
    slug: 'zamalek-brushstroke',
    nameEn: 'Zamalek Brushstroke',
    nameAr: 'الزمالك بلمسة فرشاة',
    collections: ['football'],
  },
  'imgi_156_d9369755-09ef-4045-b123-ac1c165d48c9copy37.jpg': {
    slug: 'ronaldo-united-7',
    nameEn: 'Cristiano Ronaldo United No. 7',
    nameAr: 'كريستيانو رونالدو يونايتد رقم 7',
    collections: ['football'],
  },
  'imgi_164_7_1bbe1a5d-0403-4639-9720-bec4e269dd2e.jpg': {
    slug: 'ronaldo-sketch-art',
    nameEn: 'Ronaldo Sketch Art',
    nameAr: 'رونالدو رسم تخطيطي',
    collections: ['football'],
  },
  'imgi_181_d9369755-09ef-4045-b123-ac1c165d48c9copy34.jpg': {
    slug: 'hala-madrid-collage',
    nameEn: 'Hala Madrid Collage',
    nameAr: 'هلا مدريد كولاج',
    collections: ['football'],
  },
  'imgi_189_MadridEmpirePhoneCase.jpg': {
    slug: 'madrid-empire',
    nameEn: 'Real Madrid Empire',
    nameAr: 'إمبراطورية ريال مدريد',
    collections: ['football'],
  },
  'imgi_206_d9369755-09ef-4045-b123-ac1c165d48c9copy25_714f7e12-f19b-4517-9322-17d1c069795b.jpg': {
    slug: 'barcelona-classic-crest',
    nameEn: 'Barcelona Classic Crest',
    nameAr: 'شعار برشلونة الكلاسيكي',
    collections: ['football'],
  },
  'imgi_214_d9369755-09ef-4045-b123-ac1c165d48c9copy16.jpg': {
    slug: '74-never-forget',
    nameEn: '74 Never Forget',
    nameAr: '74 لن ننسى',
    collections: ['football'],
  },
  'imgi_222_d9369755-09ef-4045-b123-ac1c165d48c9copy60.jpg': {
    slug: 'ronaldo-newspaper-collage',
    nameEn: 'Ronaldo Newspaper Collage',
    nameAr: 'رونالدو كولاج صحفي',
    collections: ['football'],
  },
  'imgi_230_HalaMadridPhoneCase.jpg': {
    slug: 'hala-madrid-mono',
    nameEn: 'Hala Madrid Mono',
    nameAr: 'هلا مدريد أحادي اللون',
    collections: ['football'],
  },
  'imgi_247_d9369755-09ef-4045-b123-ac1c165d48c9copy59.jpg': {
    slug: 'al-ahly-champion-22',
    nameEn: 'Al Ahly Champion No. 22',
    nameAr: 'الأهلي بطل رقم 22',
    collections: ['football'],
  },
  'imgi_255_d9369755-09ef-4045-b123-ac1c165d48c9copy3.jpg': {
    slug: 'al-ahly-century-crest',
    nameEn: 'Al Ahly Club of the Century',
    nameAr: 'الأهلي نادي القرن',
    collections: ['football'],
  },
  'imgi_263_d9369755-09ef-4045-b123-ac1c165d48c9copy7.jpg': {
    slug: 'cr7-real-madrid-fade',
    nameEn: 'CR7 Real Madrid Fade',
    nameAr: 'سي آر 7 ريال مدريد',
    collections: ['football'],
  },
  'imgi_271_d9369755-09ef-4045-b123-ac1c165d48c9copy35.jpg': {
    slug: 'al-ahly-grunge',
    nameEn: 'Al Ahly Grunge',
    nameAr: 'الأهلي جرنج',
    collections: ['football'],
  },
  'imgi_279_d9369755-09ef-4045-b123-ac1c165d48c9copy49.jpg': {
    slug: 'ronaldo-never-give-up',
    nameEn: 'Ronaldo – Never Give Up',
    nameAr: 'رونالدو - لا تستسلم أبدًا',
    collections: ['football', 'quotes'],
  },
  'imgi_287_d9369755-09ef-4045-b123-ac1c165d48c9copy28.jpg': {
    slug: 'barcelona-anime-squad',
    nameEn: 'Barcelona Anime Squad',
    nameAr: 'برشلونة أنمي',
    collections: ['football'],
  },
  'imgi_295_d9369755-09ef-4045-b123-ac1c165d48c9copy48.jpg': {
    slug: 'ronaldo-gold-collage',
    nameEn: 'Ronaldo Gold Collage',
    nameAr: 'رونالدو كولاج ذهبي',
    collections: ['football'],
  },
  'imgi_303_d9369755-09ef-4045-b123-ac1c165d48c9copy20.jpg': {
    slug: 'zamalek-knight',
    nameEn: 'Zamalek Knight Emblem',
    nameAr: 'شعار فارس الزمالك',
    collections: ['football'],
  },
  'imgi_311_d9369755-09ef-4045-b123-ac1c165d48c9copy57.jpg': {
    slug: 'al-ahly-eagle-textured',
    nameEn: 'Al Ahly Eagle Textured',
    nameAr: 'نسر الأهلي بخامة',
    collections: ['football'],
  },
  'imgi_319_d9369755-09ef-4045-b123-ac1c165d48c9copy54.jpg': {
    slug: 'barcelona-textured-stripes',
    nameEn: 'Barcelona Textured Stripes',
    nameAr: 'خطوط برشلونة بخامة',
    collections: ['football'],
  },
  'imgi_327_d9369755-09ef-4045-b123-ac1c165d48c9copy45.jpg': {
    slug: 'real-madrid-wordmark-white',
    nameEn: 'Real Madrid Wordmark (White)',
    nameAr: 'ريال مدريد شعار نصي (أبيض)',
    collections: ['football'],
  },
  'imgi_335_d9369755-09ef-4045-b123-ac1c165d48c9copy11.jpg': {
    slug: 'al-ahly-arabic-slogan',
    nameEn: 'Al Ahly Arabic Slogan',
    nameAr: 'عمري ما حب غير الأهلي',
    collections: ['football'],
  },
  'imgi_343_d9369755-09ef-4045-b123-ac1c165d48c9copy32.jpg': {
    slug: 'real-madrid-gold-dragon',
    nameEn: 'Real Madrid Gold Dragon',
    nameAr: 'ريال مدريد التنين الذهبي',
    collections: ['football'],
  },
  'imgi_351_d9369755-09ef-4045-b123-ac1c165d48c9copy6.jpg': {
    slug: 'hala-madrid-vintage-collage',
    nameEn: 'Hala Madrid Vintage Collage',
    nameAr: 'هلا مدريد كولاج كلاسيكي',
    collections: ['football'],
  },
  'imgi_359_d9369755-09ef-4045-b123-ac1c165d48c9copy47.jpg': {
    slug: 'real-madrid-trophy-silhouette',
    nameEn: 'Real Madrid Trophy Silhouette',
    nameAr: 'ريال مدريد ظل الكؤوس',
    collections: ['football'],
  },
  'imgi_367_d9369755-09ef-4045-b123-ac1c165d48c9copy26_1a73fd0e-c690-4ce3-b4ed-5b7f50fbf4f1.jpg': {
    slug: 'pedri-gonzalez',
    nameEn: 'Pedri González',
    nameAr: 'بيدري غونزاليس',
    collections: ['football'],
  },
  'imgi_375_d9369755-09ef-4045-b123-ac1c165d48c9copy50.jpg': {
    slug: 'zamalek-tv-wall',
    nameEn: 'Zamalek TV Wall',
    nameAr: 'الزمالك حائط الشاشات',
    collections: ['football'],
  },
  'imgi_383_d9369755-09ef-4045-b123-ac1c165d48c9copy1.jpg': {
    slug: 'hala-madrid-purple',
    nameEn: 'Hala Madrid Purple',
    nameAr: 'هلا مدريد بنفسجي',
    collections: ['football'],
  },
  'imgi_391_d9369755-09ef-4045-b123-ac1c165d48c9copy19_08b78123-a4f5-4d04-8773-0f38e461a546.jpg': {
    slug: 'zamalek-comic-strip',
    nameEn: 'Zamalek Comic Strip',
    nameAr: 'الزمالك كوميكس',
    collections: ['football'],
  },
  'imgi_399_d9369755-09ef-4045-b123-ac1c165d48c9copy2.jpg': {
    slug: 'abo-trika-tribute',
    nameEn: 'Abo Trika Tribute',
    nameAr: 'تريكة',
    collections: ['football'],
  },
  'imgi_407_d9369755-09ef-4045-b123-ac1c165d48c9copy46.jpg': {
    slug: 'real-madrid-wordmark-black',
    nameEn: 'Real Madrid Wordmark (Black)',
    nameAr: 'ريال مدريد شعار نصي (أسود)',
    collections: ['football'],
  },
  'imgi_415_d9369755-09ef-4045-b123-ac1c165d48c9copy4.jpg': {
    slug: 'barcelona-wordmark-red',
    nameEn: 'Barcelona Wordmark',
    nameAr: 'برشلونة شعار نصي',
    collections: ['football'],
  },
  'imgi_423_d9369755-09ef-4045-b123-ac1c165d48c9copy14.jpg': {
    slug: 'zamalek-85-45',
    nameEn: 'Zamalek 85:45',
    nameAr: 'الزمالك 85:45',
    collections: ['football'],
  },
  'imgi_431_d9369755-09ef-4045-b123-ac1c165d48c9copy56.jpg': {
    slug: 'zamalek-mono-1911',
    nameEn: 'Zamalek Mono 1911',
    nameAr: 'الزمالك 1911',
    collections: ['football'],
  },
  'imgi_439_d9369755-09ef-4045-b123-ac1c165d48c9copy53.jpg': {
    slug: 'ronaldo-birthday',
    nameEn: 'Ronaldo Feliz Cumpleaños',
    nameAr: 'رونالدو عيد ميلاد سعيد',
    collections: ['football'],
  },
  'imgi_447_d9369755-09ef-4045-b123-ac1c165d48c9copy12.jpg': {
    slug: 'al-ahly-22-collage',
    nameEn: 'Al Ahly No. 22 Collage',
    nameAr: 'الأهلي كولاج رقم 22',
    collections: ['football'],
  },
  'imgi_455_d9369755-09ef-4045-b123-ac1c165d48c9copy51.jpg': {
    slug: 'shikabala-10',
    nameEn: 'Shikabala No. 10',
    nameAr: 'شيكابالا رقم 10',
    collections: ['football'],
  },
  'imgi_463_d9369755-09ef-4045-b123-ac1c165d48c9copy27.jpg': {
    slug: 'lamine-yamal-19',
    nameEn: 'Lamine Yamal No. 19',
    nameAr: 'لامين يامال رقم 19',
    collections: ['football'],
  },
  'imgi_471_d9369755-09ef-4045-b123-ac1c165d48c9copy29.jpg': {
    slug: 'barca-barca-barca',
    nameEn: 'Barça Barça Barça',
    nameAr: 'برشا برشا برشا',
    collections: ['football'],
  },
  'imgi_479_d9369755-09ef-4045-b123-ac1c165d48c9copy55.jpg': {
    slug: 'barca-stripes-sticker',
    nameEn: 'Barça Stripes Sticker',
    nameAr: 'برشا ملصق مخطط',
    collections: ['football'],
  },
  'imgi_487_d9369755-09ef-4045-b123-ac1c165d48c9copy43.jpg': {
    slug: 'i-am-madridista',
    nameEn: 'I Am Madridista',
    nameAr: 'أنا مدريدي',
    collections: ['football', 'quotes'],
  },
  'imgi_495_d9369755-09ef-4045-b123-ac1c165d48c9copy33.jpg': {
    slug: 'real-madrid-legends-dark',
    nameEn: 'Real Madrid Legends',
    nameAr: 'أساطير ريال مدريد',
    collections: ['football'],
  },
  'imgi_503_d9369755-09ef-4045-b123-ac1c165d48c9copy30.jpg': {
    slug: 'a-por-la-undecima',
    nameEn: 'A Por La Undécima',
    nameAr: 'نحو اللقب الحادي عشر',
    collections: ['football'],
  },
  'imgi_511_d9369755-09ef-4045-b123-ac1c165d48c9copy18.jpg': {
    slug: 'crimson-weathered-stripe',
    nameEn: 'Crimson Weathered Stripe',
    nameAr: 'خط قرمزي متآكل',
    // No club crest/text visible in this particular image - deliberately
    // not tagged "football" despite coming from the same scrape family as
    // the rest, see the import plan.
    collections: [],
  },
  'imgi_519_d9369755-09ef-4045-b123-ac1c165d48c9copy15.jpg': {
    slug: 'al-ahly-vintage-legend',
    nameEn: 'Al Ahly Vintage Legend',
    nameAr: 'أسطورة الأهلي الكلاسيكية',
    collections: ['football'],
  },
  'imgi_74_d9369755-09ef-4045-b123-ac1c165d48c9copy8.jpg': {
    slug: 'cristiano-poster',
    nameEn: 'Cristiano Poster',
    nameAr: 'كريستيانو بوستر',
    collections: ['football'],
  },
  'imgi_91_d9369755-09ef-4045-b123-ac1c165d48c9copy10.jpg': {
    slug: 'curva-sud',
    nameEn: 'Curva Sud Ultras',
    nameAr: 'كورفا سود ألتراس',
    collections: ['football'],
  },
  'imgi_99_d9369755-09ef-4045-b123-ac1c165d48c9copy9.jpg': {
    slug: 'ronaldo-discipline',
    nameEn: 'Ronaldo Discipline',
    nameAr: 'رونالدو انضباط',
    collections: ['football', 'quotes'],
  },
};
