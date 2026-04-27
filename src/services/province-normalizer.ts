function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const CANONICAL_ALIASES: Record<string, string[]> = {
  'Ha Noi': ['hanoi'],
  'Hai Phong': ['hai duong'],
  'Hue': ['thua thien hue'],
  'Da Nang': ['quang nam'],
  'Ho Chi Minh City': ['hcmc', 'tphcm', 'tp hcm', 'saigon', 'binh duong', 'ba ria vung tau', 'vung tau'],
  'Can Tho': ['hau giang', 'soc trang'],
  'Cao Bang': [],
  'Tuyen Quang': ['ha giang'],
  'Lao Cai': ['yen bai'],
  'Thai Nguyen': ['bac kan'],
  'Lang Son': [],
  'Quang Ninh': ['ha long'],
  'Bac Ninh': ['bac giang'],
  'Phu Tho': ['vinh phuc', 'hoa binh', 'viet tri'],
  'Dien Bien': [],
  'Lai Chau': [],
  'Son La': [],
  'Hung Yen': ['thai binh'],
  'Ninh Binh': ['ha nam', 'nam dinh'],
  'Thanh Hoa': [],
  'Nghe An': ['vinh'],
  'Ha Tinh': [],
  'Quang Tri': ['quang binh', 'dong ha'],
  'Quang Ngai': ['kon tum'],
  'Gia Lai': ['binh dinh', 'pleiku'],
  'Khanh Hoa': ['nha trang', 'ninh thuan'],
  'Lam Dong': ['da lat', 'dak nong', 'binh thuan'],
  'Dak Lak': ['daklak', 'buon ma thuot', 'phu yen'],
  'Dong Nai': ['bien hoa', 'binh phuoc'],
  'Tay Ninh': ['long an'],
  'Dong Thap': ['cao lanh', 'tien giang'],
  'Vinh Long': ['ben tre', 'tra vinh'],
  'An Giang': ['long xuyen', 'kien giang'],
  'Ca Mau': ['bac lieu'],
};

const CANONICAL_BY_ALIAS = new Map<string, string>();
for (const [province, aliases] of Object.entries(CANONICAL_ALIASES)) {
  CANONICAL_BY_ALIAS.set(normalizeText(province), province);
  for (const alias of aliases) CANONICAL_BY_ALIAS.set(normalizeText(alias), province);
}

export function canonicalProvinceName(value: string | null | undefined): string {
  if (!value) return '';
  const normalized = normalizeText(value);
  if (!normalized) return '';
  const exact = CANONICAL_BY_ALIAS.get(normalized);
  if (exact) return exact;

  for (const [alias, province] of CANONICAL_BY_ALIAS.entries()) {
    if (normalized.includes(alias) || alias.includes(normalized)) return province;
  }
  return value.trim();
}
