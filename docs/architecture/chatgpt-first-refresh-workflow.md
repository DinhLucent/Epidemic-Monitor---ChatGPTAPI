# ChatGPT-First Refresh Workflow

## Muc tieu

ChatGPT la lop xu ly chinh cho phan loai, trich xuat va kiem dinh tin dich
benh. Vi ChatGPT cham nhung do chinh xac cao, ung dung khong nen goi ChatGPT
truc tiep trong request nguoi dung. He thong nen chay ChatGPT thuong xuyen o
nen, luu snapshot da xu ly, va de UI chi doc snapshot nhanh.

Pham vi du lieu van giu chat: chi tin dich benh trong lanh tho Viet Nam hoac
lien quan truc tiep Viet Nam.

## Workflow de xuat

```text
Scheduler
-> fetch source index/RSS/search result
-> URL + content dedupe
-> ChatGPT Stage 1 classify batch
-> ChatGPT Stage 2 extract detail for positives/ambiguous items
-> ChatGPT Stage 3 verify only risky/low-confidence alerts
-> merge same event by disease + province + day
-> write canonical event store / D1
-> publish read-optimized snapshot
-> UI reads snapshot
```

## Lich chay

| Job | Tan suat | Muc dich |
| --- | --- | --- |
| Fast scan | 10 phut | Quet RSS/index cua nguon cho phep, chi xu ly bai moi/chua thay doi. |
| Deep scan | 1 gio | Doc day du hon cac nguon official, dia phuong, SKDS, CDC/SYT neu co. |
| Verification pass | 30-60 phut | Kiem dinh lai cac tin alert, tin mot nguon, tin confidence thap. |
| Source review | 1 ngay | De ChatGPT goi y nguon moi, nhung chi dua vao allowlist sau khi kiem tra. |
| Historical backfill | 1 ngay | Bo sung timeline va sua lai ban ghi cu khi prompt/schema thay doi. |

## Lane song song

ChatGPT nen chay theo lane co gioi han:

| Lane | Concurrency de xuat | Ghi chu |
| --- | ---: | --- |
| RSS/source fetch | 8-12 | Network thuong nhanh, co the song song cao. |
| Stage 1 classify | 2 mac dinh, 3-4 neu nhieu key/session on dinh | Batch 25 bai/lane. |
| Stage 2 extract | 2 | Chi chay cho positive/ambiguous, khong chay tat ca bai. |
| Stage 3 verify | 1-2 | Chi chay cho alert, single-source, low-confidence. |

Khong nen tang concurrency vo han. ChatGPT2API/Web session co the bi treo hoac
rate-limit mem. Mot vong refresh phai co hard timeout va retry.

## Benchmark hien tai

Do tren dev middleware voi 12 RSS source, 8 bai moi moi nguon, 50 candidate dua
vao ChatGPT:

| Cau hinh | Tong chu trinh | RSS fetch | Stage 1 classify | Stage 2 extract |
| --- | ---: | ---: | ---: | ---: |
| classify concurrency 1 | ~100.7s | ~0.6s | ~93.2s | ~7.0s |
| classify concurrency 2 | ~73.2s | ~0.34s | ~52.9s | ~20.0s |

Ket luan: nut that la Stage 1 ChatGPT, khong phai RSS. Toi uu tot nhat la:

1. chay nen thay vi request-time;
2. chi gui bai moi/chua xu ly vao ChatGPT;
3. dung 2-4 classify lanes co state rieng;
4. gioi han Stage 2 vao positive/ambiguous;
5. publish snapshot de UI doc nhanh.

## Quy tac do chinh xac

Stage 1 khong duoc dua bai vao OUTBREAK neu thieu bang chung su kien dich te:

- so ca, tu vong, nhap vien, duong tinh;
- o dich/cum ca/diem nong;
- ghi nhan, xuat hien, phat hien, truy vet;
- canh bao CDC, So Y te, Bo Y te hoac co quan y te.

Loai nhung bai tu van suc khoe chung neu khong co su kien cu the:

- trieu chung, dinh duong, cach phong benh chung;
- benh man tinh, ung thu, tieu duong, di ung, ton thuong than;
- meo vat, PR, thuc pham chuc nang.

Stage 2 chi trich xuat khi Stage 1 da qua filter. Stage 3 verify chi chay khi:

- `alertLevel = alert`;
- chi co mot nguon;
- thieu tinh/thanh hoac thieu so ca;
- disease/province mâu thuẫn giữa nhiều nguồn;
- title co tu de nham nhu `lao`, `dai`, `cum`, `sot`.

## Dedup va merge

Can co 3 lop khong trung lap:

1. Article dedupe: canonical URL + content hash.
2. Seen cache: URL/content fingerprint -> classification/extraction cu.
3. Event merge: disease + province + day -> mot signal duy nhat.

Neu cung mot su kien co nhieu bai, signal nen tang `sourceCount`, giu link goc,
chon title/summary tot nhat, va nang confidence thay vi tao nhieu marker.

## Seed va consensus

Khong nen dung nhieu seed cho moi bai mac dinh vi thoi gian tang tuyen tinh.
Dung consensus co dieu kien:

- Tin alert hoac anh huong lon: chay lai voi prompt verify doc lap.
- Tin chi mot nguon: verify truoc khi nang len `alert`.
- Tin low-confidence: giu `watch` hoac dua vao queue cho lan sau.

Khi co nhieu ket qua, merge theo nguyen tac bao thu:

- disease/province/cases phai dong thuan hoac co bang chung nguon;
- neu mau thuan, ha alert level va gan warning;
- khong cong bo marker neu khong co tinh/thanh hop le.

## Cau hinh local khuyen nghi

```env
CHATGPT2API_BASE_URL=http://127.0.0.1:8010
CHATGPT2API_MODEL=auto
CHATGPT2API_CLASSIFY_CONCURRENCY=2
CHATGPT2API_CLASSIFY_BATCH_SIZE=25
CHATGPT_REFRESH_CLASSIFY_JOB_LIMIT=50
CHATGPT_REFRESH_EXTRACT_JOB_LIMIT=4
CHATGPT_REFRESH_VERIFY_JOB_LIMIT=2
OUTBREAK_REFRESH_INTERVAL_MS=600000
OUTBREAK_REFRESH_HARD_TIMEOUT_MS=480000
```

## Worker da trien khai

Worker nen duoc chay bang npm script:

```powershell
npm run refresh:chatgpt
npm run refresh:chatgpt:loop
npm run refresh:chatgpt:worker
npm run refresh:chatgpt:legacy
npm run refresh:chatgpt:prod
npm run refresh:chatgpt:prod:loop
```

Mac dinh worker chay queue SQLite, khong phai seen-cache JSON. Queue nay giu
article, job `classify/extract/verify`, event da merge, source health va lich su
run. Nho vay co the:

- quet tat ca item RSS trong source da cau hinh, khong bi cap `maxAiItems`;
- chi classify bai moi hoac bai co fingerprint thay doi;
- retry job loi va dua job loi lap lai vao `DEAD_LETTER`;
- chay them worker bang `npm run refresh:chatgpt:worker` de xu ly queue song
  song ma khong fetch RSS trung lap;
- verify co dieu kien cho alert, confidence thap, hoac tin thieu so ca.
- giu snapshot truoc do neu queue moi dang drain va chua co event published, de
  UI khong bi trong tam thoi trong lan warm-up dau.

Mac dinh worker ghi snapshot vao:

```text
.chatgpt-refresh/latest-snapshot.json
```

Va queue ben vung vao:

```text
.chatgpt-refresh/queue.db
```

Dev middleware co the doc snapshot nay neu `OUTBREAK_PREFER_WORKER_SNAPSHOT=1`.
Sau vong dau, cac vong tiep theo chi goi ChatGPT cho bai moi hoac bai co noi
dung thay doi. Neu can luong cu de benchmark, dung `npm run refresh:chatgpt:legacy`.

Benchmark worker hien tai:

| Trang thai | Tong chu trinh | Ghi chu |
| --- | ---: | --- |
| First full queue run | Phu thuoc queue limit | Quet all RSS item, moi vong xu ly toi da `classify/extract/verify` job limit. |
| Warm run, khong co bai moi | ~1-2s + RSS fetch | Khong goi lai ChatGPT neu khong co fingerprint moi. |
| Extra worker | Song song theo job claim | Dung `--skip-scan --loop` de tang toc drain queue. |

Neu co nhieu key/session on dinh:

```env
CHATGPT2API_AUTH_KEYS=key1,key2,key3
CHATGPT2API_CLASSIFY_CONCURRENCY=3
```

Co the tang throughput bang cach chay mot scheduler va nhieu worker:

```powershell
npm run refresh:chatgpt:loop
npm run refresh:chatgpt:worker
npm run refresh:chatgpt:worker
```

SQLite job claim ngan hai worker xu ly cung mot job. Stale job se duoc recover
sau `CHATGPT_REFRESH_JOB_LOCK_TTL_MS` de tranh ket hang doi neu mot session bi
treo.

## Production D1 writer

Pages Functions chi doc D1. ChatGPT khong nam trong request path production.
Worker production ghi ket qua da xu ly vao bang `outbreak_items`:

```powershell
npm run db:migrate:prod
npm run refresh:chatgpt:prod:loop
```

Khi can sync lai queue/snapshot hien co:

```powershell
npm run sync:d1:prod
```

Lenh local de test truoc khi day remote:

```powershell
npm run db:migrate:local
npm run sync:d1
```

Worker production co the chia thanh:

```text
1 scheduler: npm run refresh:chatgpt:prod:loop
N worker:   npm run refresh:chatgpt:worker
```

Scheduler fetch RSS, enqueue job, drain mot phan queue va upsert D1 sau moi
vong. Worker phu dung `--skip-scan` de chi claim job trong SQLite, khong fetch
source trung lap. Neu muon worker phu cung sync D1, chay worker truc tiep voi
`node scripts/chatgpt-refresh-worker.mjs --skip-scan --loop --sync-d1 --d1-remote`.

Bang D1 duoc khai bao trong `migrations/0001_outbreak_items.sql`. Script sync
`scripts/sync-chatgpt-queue-to-d1.mjs` cung tu tao bang/index neu DB moi chua co
schema, nhung migration van la duong chinh cho production.

## Production target

Dev middleware hien co the lam prototype, nhung production nen tach thanh worker
rieng:

```text
Long-running worker / cron host
-> ChatGPT2API
-> D1 writer
-> Cloudflare Pages Functions read-only API
```

Cloudflare Pages Functions khong nen goi ChatGPT trong request path. Request path
chi nen doc D1/snapshot da co san de luon nhanh va on dinh.
