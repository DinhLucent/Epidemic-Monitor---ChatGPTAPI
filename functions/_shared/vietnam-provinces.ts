export interface VietnamProvince {
  name: string;
  lat: number;
  lng: number;
  aliases: string[];
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const VIETNAM_PROVINCES_2025: VietnamProvince[] = [
  { name: 'Ha Noi', lat: 21.0285, lng: 105.8542, aliases: ['hanoi'] },
  { name: 'Hai Phong', lat: 20.8449, lng: 106.6881, aliases: ['hai duong'] },
  { name: 'Hue', lat: 16.4637, lng: 107.5909, aliases: ['thua thien hue'] },
  { name: 'Da Nang', lat: 16.0678, lng: 108.2208, aliases: ['quang nam'] },
  { name: 'Ho Chi Minh City', lat: 10.7769, lng: 106.7009, aliases: ['hcmc', 'tphcm', 'tp hcm', 'saigon', 'binh duong', 'ba ria vung tau', 'vung tau'] },
  { name: 'Can Tho', lat: 10.0452, lng: 105.7469, aliases: ['hau giang', 'soc trang'] },
  { name: 'Cao Bang', lat: 22.6667, lng: 106.2639, aliases: [] },
  { name: 'Tuyen Quang', lat: 21.8233, lng: 105.2181, aliases: ['ha giang'] },
  { name: 'Lao Cai', lat: 22.4809, lng: 103.9755, aliases: ['yen bai'] },
  { name: 'Thai Nguyen', lat: 21.5942, lng: 105.8482, aliases: ['bac kan'] },
  { name: 'Lang Son', lat: 21.8537, lng: 106.7615, aliases: [] },
  { name: 'Quang Ninh', lat: 20.9712, lng: 107.0448, aliases: ['ha long'] },
  { name: 'Bac Ninh', lat: 21.1861, lng: 106.0763, aliases: ['bac giang'] },
  { name: 'Phu Tho', lat: 21.3227, lng: 105.4020, aliases: ['vinh phuc', 'hoa binh', 'viet tri'] },
  { name: 'Dien Bien', lat: 21.3860, lng: 103.0169, aliases: [] },
  { name: 'Lai Chau', lat: 22.3964, lng: 103.4582, aliases: [] },
  { name: 'Son La', lat: 21.3270, lng: 103.9141, aliases: [] },
  { name: 'Hung Yen', lat: 20.6464, lng: 106.0511, aliases: ['thai binh'] },
  { name: 'Ninh Binh', lat: 20.2506, lng: 105.9744, aliases: ['ha nam', 'nam dinh'] },
  { name: 'Thanh Hoa', lat: 19.8067, lng: 105.7852, aliases: [] },
  { name: 'Nghe An', lat: 18.6796, lng: 105.6813, aliases: ['vinh'] },
  { name: 'Ha Tinh', lat: 18.3428, lng: 105.9057, aliases: [] },
  { name: 'Quang Tri', lat: 16.8185, lng: 107.1003, aliases: ['quang binh', 'dong ha'] },
  { name: 'Quang Ngai', lat: 15.1205, lng: 108.7923, aliases: ['kon tum'] },
  { name: 'Gia Lai', lat: 13.9833, lng: 108.0000, aliases: ['binh dinh', 'pleiku'] },
  { name: 'Khanh Hoa', lat: 12.2388, lng: 109.1967, aliases: ['nha trang', 'ninh thuan'] },
  { name: 'Lam Dong', lat: 11.9404, lng: 108.4583, aliases: ['da lat', 'dak nong', 'binh thuan'] },
  { name: 'Dak Lak', lat: 12.6667, lng: 108.0500, aliases: ['daklak', 'buon ma thuot', 'phu yen'] },
  { name: 'Dong Nai', lat: 10.9447, lng: 106.8243, aliases: ['bien hoa', 'binh phuoc'] },
  { name: 'Tay Ninh', lat: 11.3134, lng: 106.0969, aliases: ['long an'] },
  { name: 'Dong Thap', lat: 10.4930, lng: 105.6882, aliases: ['cao lanh', 'tien giang'] },
  { name: 'Vinh Long', lat: 10.2537, lng: 105.9722, aliases: ['ben tre', 'tra vinh'] },
  { name: 'An Giang', lat: 10.3864, lng: 105.4352, aliases: ['long xuyen', 'kien giang'] },
  { name: 'Ca Mau', lat: 9.1768, lng: 105.1524, aliases: ['bac lieu'] },
];

const CANONICAL_BY_ALIAS = new Map<string, VietnamProvince>();
for (const province of VIETNAM_PROVINCES_2025) {
  CANONICAL_BY_ALIAS.set(normalizeText(province.name), province);
  for (const alias of province.aliases) CANONICAL_BY_ALIAS.set(normalizeText(alias), province);
}

export function canonicalProvinceName(value: string | null | undefined): string {
  if (!value) return '';
  const normalized = normalizeText(value);
  if (!normalized) return '';
  const exact = CANONICAL_BY_ALIAS.get(normalized);
  if (exact) return exact.name;

  for (const [alias, province] of CANONICAL_BY_ALIAS.entries()) {
    if (normalized.includes(alias) || alias.includes(normalized)) return province.name;
  }
  return value.trim();
}
