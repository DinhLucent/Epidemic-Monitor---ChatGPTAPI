import assert from 'node:assert/strict';
import {
  acceptedClassifiedOutbreak,
  articleStatusFromClassification,
  compareAiCandidate,
  inferProvinceFromText,
  isPublishablePublicHealthSignal,
  normalizeClassifyRows,
  outbreakSignalScore,
} from './chatgpt-refresh-worker.mjs';

const fixtures = [
  {
    id: 'politics-noise',
    sourceName: 'VietnamPlus',
    title: 'Khai mạc triển lãm quốc tế khoa học công nghệ thủy sản Việt Nam',
    description: 'Hoạt động triển lãm và hợp tác thương mại, không có thông tin y tế.',
    pubDate: 'Tue, 28 Apr 2026 15:00:00 +0700',
    link: 'https://example.test/politics-noise',
  },
  {
    id: 'food-poisoning-hcm',
    sourceName: 'Suc Khoe Doi Song',
    title: 'TPHCM: 25 ca nghi ngộ độc thực phẩm tại Trường tiểu học Đặng Thùy Trâm, có ca sốc, co giật',
    description: 'Sở Y tế TP.HCM đang điều tra, nhiều học sinh nhập viện, một ca diễn tiến nặng.',
    pubDate: 'Tue, 28 Apr 2026 10:11:00 +0700',
    link: 'https://example.test/food-poisoning-hcm',
  },
  {
    id: 'meningococcal-daklak',
    sourceName: 'Thanh Nien',
    title: 'Xuất hiện viêm não mô cầu, Đắk Lắk khẩn trương truy vết người tiếp xúc',
    description: 'CDC địa phương ghi nhận ca bệnh và triển khai giám sát, truy vết.',
    pubDate: 'Tue, 28 Apr 2026 09:10:00 +0700',
    link: 'https://example.test/meningococcal-daklak',
  },
  {
    id: 'hfmd-signal',
    sourceName: 'Nguoi Lao Dong',
    title: 'Dịch bệnh tay chân miệng diễn biến phức tạp',
    description: 'Số ca bệnh tay chân miệng gia tăng, ngành y tế khuyến cáo giám sát trẻ mắc bệnh.',
    pubDate: 'Tue, 28 Apr 2026 05:27:00 +0700',
    link: 'https://example.test/hfmd-signal',
  },
  {
    id: 'xe-lao-false-positive',
    sourceName: 'Bao Giao Thong',
    title: 'Xe lao xuống vực, nhiều người bị thương',
    description: 'Tai nạn giao thông trên đèo, không liên quan bệnh lao.',
    pubDate: 'Tue, 28 Apr 2026 12:00:00 +0700',
    link: 'https://example.test/xe-lao',
  },
  {
    id: 'co-dai-false-positive',
    sourceName: 'VietnamNet',
    title: "Ít ai ngờ cây dại 'anh em' với cà phê lại là kho báu cho sức khỏe",
    description: 'Bài viết về cây mọc dại và thảo dược, không liên quan bệnh dại.',
    pubDate: 'Tue, 28 Apr 2026 11:00:00 +0700',
    link: 'https://example.test/co-dai',
  },
  {
    id: 'general-health',
    sourceName: 'VnExpress',
    title: 'Dấu hiệu ban đêm cảnh báo gan đang kêu cứu',
    description: 'Bài tư vấn triệu chứng và sức khỏe cá nhân, không có ổ dịch hoặc ca bệnh cộng đồng.',
    pubDate: 'Tue, 28 Apr 2026 13:00:00 +0700',
    link: 'https://example.test/general-health',
  },
];

const objectRows = normalizeClassifyRows({
  articles: [{ index: 0, classification: 'IRRELEVANT', confidence: 0.9, reasoning: 'noise' }],
});
const arrayRows = normalizeClassifyRows([
  { index: 0, classification: 'IRRELEVANT', confidence: 0.9, reasoning: 'noise' },
]);
assert.equal(objectRows.length, 1, 'object wrapper schema should be accepted');
assert.equal(arrayRows.length, 1, 'top-level array schema should be accepted');

const ranked = [...fixtures].sort(compareAiCandidate);
assert.equal(ranked[0].id, 'food-poisoning-hcm', 'food-poisoning signal should outrank newer broad news');
assert(ranked.slice(0, 3).some((item) => item.id === 'meningococcal-daklak'), 'meningococcal signal should be prioritized');
assert(outbreakSignalScore(fixtures[1]) > outbreakSignalScore(fixtures[0]), 'signal score should separate outbreak candidates from broad news');

assert.equal(inferProvinceFromText(fixtures[1].title), 'TPHCM', 'TP.HCM should be inferred from title');
assert.equal(inferProvinceFromText(fixtures[2].title), 'Dak Lak', 'Dak Lak should be inferred from title');

const mockRows = new Map([
  ['food-poisoning-hcm', {
    classification: 'OUTBREAK',
    disease_vn: 'ngộ độc thực phẩm',
    alert_level: 'warning',
    province: null,
    country: 'Vietnam',
    confidence: 0.95,
  }],
  ['meningococcal-daklak', {
    classification: 'OUTBREAK',
    disease_vn: 'viêm não mô cầu',
    alert_level: 'alert',
    province: 'Đắk Lắk',
    country: 'Vietnam',
    confidence: 0.96,
  }],
  ['hfmd-signal', {
    classification: 'OUTBREAK',
    disease_vn: 'tay chân miệng',
    alert_level: 'warning',
    province: 'TPHCM',
    country: 'Vietnam',
    confidence: 0.9,
  }],
  ['xe-lao-false-positive', {
    classification: 'OUTBREAK',
    disease_vn: 'lao',
    alert_level: 'warning',
    province: 'Lào Cai',
    country: 'Vietnam',
    confidence: 0.9,
  }],
  ['co-dai-false-positive', {
    classification: 'OUTBREAK',
    disease_vn: 'dại',
    alert_level: 'warning',
    province: 'Hà Nội',
    country: 'Vietnam',
    confidence: 0.9,
  }],
  ['general-health', {
    classification: 'HEALTH_NEWS',
    disease_vn: null,
    alert_level: null,
    province: null,
    country: 'Vietnam',
    confidence: 0.9,
  }],
]);

const accepted = fixtures
  .map((item) => {
    const row = mockRows.get(item.id) ?? {
      classification: 'IRRELEVANT',
      disease_vn: null,
      alert_level: null,
      province: null,
      country: 'Vietnam',
      confidence: 0.9,
    };
    return acceptedClassifiedOutbreak(row, item);
  })
  .filter(Boolean);

assert.deepEqual(
  accepted.map((row) => row.item.id).sort(),
  ['food-poisoning-hcm', 'hfmd-signal', 'meningococcal-daklak'].sort(),
  'only real Vietnam outbreak candidates should pass final classify gate',
);

assert.equal(
  articleStatusFromClassification({ classification: 'HEALTH_NEWS' }, false),
  'NEWS_ONLY',
  'health news should be syncable as news-only, not mixed with rejected noise',
);
assert.equal(
  articleStatusFromClassification({ classification: 'IRRELEVANT' }, false),
  'REJECTED',
  'irrelevant articles should not be synced into the news feed',
);
assert.equal(
  isPublishablePublicHealthSignal('xuất huyết tiêu hóa', 'ca bệnh hiếm gặp ở cụ ông, nguy kịch sau vài giờ'),
  false,
  'individual clinical case should not be published as an outbreak signal',
);
assert.equal(
  isPublishablePublicHealthSignal('ngộ độc thực vật', 'nuốt mủ hoa sứ, 2 trẻ nhập viện cấp cứu vì ngộ độc'),
  false,
  'small accidental plant poisoning should not be published as an outbreak signal',
);
assert.equal(
  isPublishablePublicHealthSignal('ngộ độc thực phẩm', '46 học sinh nghi ngộ độc sau khi ăn bánh bao miễn phí tại trường học'),
  true,
  'school food-poisoning cluster should remain publishable',
);

console.log(JSON.stringify({
  ok: true,
  rankedTop: ranked.slice(0, 5).map((item) => ({ id: item.id, score: outbreakSignalScore(item) })),
  accepted: accepted.map((row) => ({
    id: row.item.id,
    disease: row.disease,
    province: row.province,
    alert: row.alert,
  })),
  rejectedFalsePositives: ['xe-lao-false-positive', 'co-dai-false-positive'],
}, null, 2));
