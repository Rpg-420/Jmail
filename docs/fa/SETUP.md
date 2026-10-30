# راه‌اندازی JMail — میل‌سرور خصوصی روی دامنهٔ خودت، برای $0

> نسخهٔ فارسی؛ متن انگلیسیِ اصلی در `docs/SETUP.md` است و همان مرجع فنی محسوب می‌شود.

این راهنمای اجرایی (runbook) کامل است: از یک حساب خالی Cloudflare تا یک صندوقِ کارِ‌کردنی که روی هر نشانیِ دامنهٔ تو نامه می‌گیرد و از طریق رله‌های رایگان بیرون می‌فرستد، به‌علاوه یک API روی HTTP که پروژه‌های دیگرِ همان مالک می‌توانند صدا بزنند.

این‌جا هیچ چیز به لایهٔ پولی نیاز ندارد. هر سه حسابی که درگیرند لایهٔ رایگانی دارند که برای استفادهٔ شخصی کافی است:

| سرویس | سهمیهٔ رایگان | چه کاری برایت انجام می‌دهد |
| --- | --- | --- |
| Cloudflare Workers + Pages/assets | `100,000 requests/day` | کل برنامه را میزانی: API، رابط کاربری تک‌صفحه‌ای، پردازشگر نامهٔ ورودی و cron |
| Cloudflare D1 | `5 GB` فضا، `5M` خواندن ردیف در روز | صندوق، تنظیمات، صف، توکن‌ها و وب‌هوک‌ها |
| Cloudflare Email Routing | بی‌سقف برای نشانی‌ها، رایگان | نامهٔ ورودی — نامه‌های دامنهٔ تو را به Worker می‌رساند |
| Cloudflare R2 (اختیاری) | `10 GB` | ذخیرهٔ پیوست‌ها، فراتر از اندازهٔ یک ردیف در D1 |
| Brevo (رلهٔ 1) | `300 emails/day` | ارسالِ خروجی از طریق API تراکنشیِ رایگان‌شان |
| Resend (رلهٔ 2، اختیاری) | `100 emails/day` | استخر دوم، تا یک روزِ پُر جلوی نامه‌هایت را نگیرد |

**چرا اصلاً رله؟** Cloudflare در لایهٔ رایگان هیچ راهی برای *فرستادن* نامه ندارد — SMTP از داخل یک Worker در دسترس نیست (پورت‌های خروجی `25/465/587` بسته‌اند) و Cloudflare Email Sending یک افزونهٔ پولی است. پس JMail مسیر دریافت را کامل روی Cloudflare نگه می‌دارد و مسیر ارسال را به APIهای HTTPS رایانی که کنار هم جمع شده‌اند می‌سپارد. مالکیت دامنه، نشانی‌ها، صندوق، API و داده‌ها باز هم خودت هستی.

اگر همهٔ کلیدهای رله را رد کنی هم JMail کار می‌کند: نامه‌های دریافتی می‌نشینند، وب‌اپ و API کار می‌کنند، و messageهای خروجی با وضعیت `queued` در صف می‌مانند تا وقتی که یک رله تنظیم شود. چیزی از دست نمی‌رود.

---

## 0. پیش از شروع چه لازم داری

- **دامنه‌ای که بتوانی nameserverهایش را به Cloudflare نشاندهی.** این تنها نیازِ قطعی است. Email Routing فقط روی zoneای کار می‌کند که روی Cloudflare میزبانی شود.
- یک حساب Cloudflare (رایگان).
- [Node.js ≥ 22.12](https://nodejs.org) و [pnpm](https://pnpm.io) (`npm i -g pnpm`).
- یک حساب Brevo (رایگان) — و اگر استخر دوم را می‌خواهی، Resend هم.
- حدود 20 دقیقه.

مرحله‌های 1 تا 7 را روی لپ‌تاپت انجام بده؛ مرحله‌هایی که در پیشخوان (dashboard) Cloudflare انجام می‌شوند با نامِ سایتی که در آن کلیک می‌کنی مشخص شده‌اند.

---

## 1. نصب کد

```bash
git clone <this repo> jmail
cd jmail
pnpm install
```

## 2. پایگاه دادهٔ D1 را بساز

```bash
npx wrangler login
npx wrangler d1 create jmail-db
```

`database_id` را از خروجی بردار. حالا تنظیمات واقعی را از روی نمونه بساز:

```bash
cp packages/worker/wrangler.toml.example packages/worker/wrangler.toml
```

`packages/worker/wrangler.toml` را ویرایش کن و آن ID را در `database_id` بگذار. `WORKER_NAME = "jmail"` را در `[vars]` دست‌نخورده بگذار — جادوی راه‌اندازی (setup wizard) از آن استفاده می‌کند تا قانون catch-all در Email Routing را به Worker تو نشانه برود، و این مقدار باید با فیلد `name` برابر باشد.

اگر نام Worker را عوض کردی، `name` و `WORKER_NAME` و `database_name` را با هم عوض کن.

## 3. schema را بساز

```bash
cd packages/worker
npx wrangler d1 execute DB --remote --file=./src/db/schema.sql
```

schema خودتکرارپذیر (idempotent) است — همه‌جا `CREATE TABLE IF NOT EXISTS` نوشته شده — پس بعد از یک ارتقا هم اجرای دوباره‌اش بی‌خطر است و جدول‌های جدید را اضافه می‌کند.

## 4. secretها

یک secret داریم؛ اختیاری است اما به‌شدت توصیه می‌شود:

```bash
# Gates the "create the admin password" step, so a stranger cannot claim your
# deployment before you do.
npx wrangler secret put SETUP_CODE
```

`SETUP_CODE` فقط یک بار خواسته می‌شود، توسط همان setup wizard. به محض اینکه رمز ادمین ذخیره شد، `/auth/setup` برای هر نفرِ بعدی `Already setup` جواب می‌دهد، پس آن secret کارش را کرده و بی‌خطر است که سر جایش بماند.

sessionها به یک کلید امضا نیاز ندارند: هر بار login یک توکن تصادفی `48` بایتی ساخته می‌شود، فقط SHA-256 hashِ آن در جدول `sessions` در D1 ذخیره می‌شود و انقضای `7` روزه دارد، و وقتی رمز را عوض می‌کنی همهٔ sessionها باطل می‌شوند. هیچ چیزی از یک کلید زمان-deploy مشتق نمی‌شود، پس یک deploy جدید هرگز loginهای تو را باطل نمی‌کند.

URL مربوط به Worker و کلیدهای API رله‌ها secret برای deploy **نیستند**؛ آن‌ها از طریق رابط وب در جدول `settings` در D1 ذخیره می‌شوند، پس می‌توانی بدون deploy دوباره عوضشان کنی.

## 5. Build و deploy

```bash
cd ../..
pnpm build            # builds frontend/dist
pnpm --filter @jmail/worker deploy
```

به URLی که چاپ می‌کند دقت کن، مثلاً `https://jmail.<your-account>.workers.dev` — همان جایی است که برنامه را باز می‌کنی. (بعداً می‌توانی آن را پشت hostname خودت بگذاری؛ بخش 12 را ببین.)

## 6. اولین اجرا: setup wizard

URL Worker را باز کن. چون هنوز هیچ رمز ادمینی وجود ندارد، در صفحهٔ راه‌اندازی می‌نشینی. به ترتیب این‌ها را می‌خواهد:

1. **رمز ادمین + `SETUP_CODE`.** رمز به‌صورت PBKDF2-SHA256 ذخیره می‌شود (`100,000` تکرار/iteration)؛ متنِ خامِ رمز هرگز به D1 نمی‌رسد.
2. **Cloudflare API token** و **account ID**، به‌علاوهٔ **دامنهٔ** تو. token را در `My Profile → API tokens → Create token` بساز و این سطح دسترسی‌ها را بده:
   - `Zone → Zone → Read` (zone را پیدا می‌کند)
   - `Zone → DNS → Edit` (wizard رکوردهایی که باید اضافه کنی را نشان می‌دهد)
   - `Zone → Email Routing Rules → Edit` (مسیریابی را روشن می‌کند و catch-all را تنظیم می‌کند)
   - `Zone → Email Routing Destinations → Edit` (یک نشانی فوروارد را تأیید می‌کند)
   - `Zone → Zone Settings → Edit` (Email Routing را فعال می‌کند)
   - `Zone → Zone → Edit` فقط اگر دامنه هنوز روی حساب تو نیست — wizard می‌تواند zone را اضافه کند.

   account ID در سمتِ راستِ صفحهٔ هر zone نوشته شده است.
3. **یک رلهٔ ارسال** — Brevo یا Resend را انتخاب کن و کلید API همان سرویس را Paste کن. JMail پیش از ذخیره کردن، کلید نزد خودِ سرویس بررسی می‌کند و هر کلیدی که احراز نشود را رد می‌کند. برای تمام کردن فقط به یکی نیاز داری؛ اگر failover را می‌خواهی، دومی را بعداً در **Mail server → Sending relays** اضافه کن. وصل کردن Brevo در همین‌جا (یا دوباره‌ذخیره کردن کلیدش در آن صفحه) آن وب‌هوک را هم ثبت می‌کند که نشان‌های `Delivered` / `Opened` / `Bounced` را تولید می‌کند.
4. **Complete setup** — تا Cloudflare و دست‌کم یک رله تنظیم نشده باشند، wizard اجازهٔ بستن نمی‌دهد، پس یک deploy نیمه‌کاره خودش می‌گوید هنوز منتظر چیست.

بعد نشانی‌های **ارسال** خودت را در **Settings → Addresses** اضافه کن — همان هویت‌های `name@yourdomain` که با آن‌ها می‌فرستی. چون دریافت به‌صورت catch-all است، هر نشانی روی دامنه‌ات برای *ورودی* از همین حالا فعال است؛ آن فهرست فقط دربارهٔ این است که با چه نام‌هایی می‌توانی *بفرستی*.

مرحلهٔ 2 این کارها را خودکار می‌کند: در صورت نیاز zone را اضافه می‌کند، Email Routing را فعال می‌کند، رکوردهای DNSای که Cloudflare لازم دارد را می‌خواند، و قانون catch-all را روی **route to Worker → `jmail`** می‌گذارد. رکوردهای SPF/DKIM/DMARC خودت را *نمی‌نویسد* — آن‌ها را خودت در بخش 8 اضافه می‌کنی.

### رله‌ها، سهمیه‌ها و failover

استخرِ سمتِ ارسال در **Mail server → Sending relays** زندگی می‌کند:

- هر رله کلید خودش (`provider_key_brevo`، `provider_key_resend`)، شمارندهٔ روزانهٔ خودش و در صورت تمایل شمارندهٔ ماهانهٔ خودش را نگه می‌دارد.
- مقدار پیش‌فرض روزانه از لایهٔ رایگانِ اعلام‌شدهٔ همان رله می‌آید — Brevo برابر `300` و Resend برابر `100`. اگر پلنت عوض شد یا می‌خواهی حاشیه‌ای بگذاری، با `PUT /api/providers/:id/quota` عوضش کن.
- `PUT /api/providers/order` ترتیب failover را تعیین می‌کند. هر ارسال به اولین رله‌ای می‌رود که جا داشته باشد؛ اگر یکی خطای سمت سرویس یا rate limit برگرداند، بعدی امتحان می‌شود؛ و وقتی همه خرجشان تمام شد، message **deferred** می‌شود، نه رد.
- بعداً همهٔ کلیدهای رله را هم برداری، JMail همچنان دریافت می‌کند، ذخیره می‌کند و در صف می‌گذارد — فقط wizard است که برای بسته شدن به یکی نیاز دارد. نامه‌های صف‌شده صبر می‌کنند و به محض اینکه رله برگردد، خودشان تخلیه می‌شوند.

## 7. دامنه را به Cloudflare نشانده کن

اگر دامنه از قبل روی حساب Cloudflare تو بود، این را رد کن. وگرنه در پنلِ ثبت‌کننده (registrar) دو nameserver را با آن دو موردی که Cloudflare داده عوض کن و صبر کن وضعیت zone به **Active** برسد (از چند دقیقه تا چند ساعت).

تا zone فعال نشده، Email Routing روشن نمی‌شود.

---

## 8. DNS: دریافت و ارسال

برو به `your domain → Email Routing → DNS records status`. Cloudflare رکوردهایی که لازم دارد را فهرست می‌کند؛ همه‌شان را اضافه کن (wizard هم می‌تواند فهرست دقیق را به تو بدهد).

**دریافت — MX (توسط Cloudflare مدیریت می‌شود):**

| Type | Name | Content | Priority |
| --- | --- | --- | --- |
| MX | `@` | `route1.mx.cloudflare.net` | 65 |
| MX | `@` | `route2.mx.cloudflare.net` | 60 |
| MX | `@` | `route3.mx.cloudflare.net` | 52 |

از همان hostnamesهایی استفاده کن که پیشخوان نشان می‌دهد؛ این‌ها per-zone هستند و Cloudflare می‌تواند خودش اضافه‌شان کند.

**ارسال — SPF، DKIM، DMARC.** این‌ها *رله* را مجاز می‌کنند، نه Cloudflare. مقدارهای دقیق را از همان صفحهٔ تأیید دامنهٔ رله‌ات بگیر — Brevo: `Senders → Domains & SMTP → Add domain`، و Resend: `Domains → Add` — و هر چه گفتند اضافه کن. معمولاً این‌طور است:

| Type | Name | Content |
| --- | --- | --- |
| TXT | `@` | `v=spf1 include:<relay-spf-host> ~all` |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@yourdomain` (با `p=none` شروع کن، بعداً سخت‌ترش کن) |
| CNAME/TXT | `<selector>._domainkey` | مقدارِ DKIMی که رله به تو می‌دهد |

دو قاعده که ساعت‌ها عیب‌یابی ذخیره می‌کنند:

- **SPF برای هر hostname فقط یک رکورد.** Email Routing خودش هم یک ورودی SPF روی `@` می‌خواهد. این دو را در یک رکورد TXT یکی کن (`v=spf1 include:a ~all include:b ~all`) و هرگز دو تا نگذار. دو رکورد یعنی هر دو نامعتبر شمرده می‌شوند.
- **همان DKIM است که واقعاً اهمیت دارد** برای تحویل شدن وقتی از رله می‌فرستی. SPF به‌تنهایی در Gmail تو را به پوشهٔ spam می‌فرستد. دامنه را در پیشخوانِ رله آن‌قدر پیگیری کن تا `verified` بگوید، بعد یک نامهٔ آزمایشی به یک نشانی Gmail بفرست و `Show original → SPF/DKIM: PASS` را بررسی کن.

---

## 9. پیوست‌ها: D1 یا R2

از همان ابتدا، پیوست‌ها به‌صورت base64 کنار همان ردیفِ message در D1 زندگی می‌کنند. این اشکالی ندارد — رایگان است و تنظیم اضافه نمی‌خواهد — اما صندوقی که پیوست زیاد دارد حسابی فضای D1 خرج می‌کند، و base64 هم هر فایل را حدود یک‌سوم بزرگ‌تر نشان می‌دهد.

برای کارِ جدی با پیوست‌ها، یک bucket در R2 اضافه کن (`10 GB` رایگان، بدون هزینهٔ ترافیک خروجی):

```bash
npx wrangler r2 bucket create jmail-attachments
```

بلوک `[[r2_buckets]]` را در `wrangler.toml` از حالت کامنت دربیاور (binding باید `ATTACHMENTS` باشد و نام bucket باید بخواند) و دوباره deploy کن. سقف هر فایل از `5 MB` به `25 MB` می‌رود. پیوست‌های قبلی که در D1 هستند به کارشان ادامه می‌دهند و موارد جدید به R2 می‌روند.

نامهٔ دریافتی موقع ذخیره شدن سقف‌دار می‌شود، تا یک بارِ spam بزرگ نتواند بودجهٔ `5 GB` فضای D1 را پر کند: `1 MB` متن، `2 MB` HTML، عنوانِ حداکثر `998` نویسه، `256 KB` هدر و `25` فایل پیوست برای هر message. هر چه بالاتر از سقف باشد نگه داشته می‌شود و داخل message علامت truncated می‌خورد و هرگز بی‌صدا دور ریخته نمی‌شود.

## 10. Cron: صف، ارسال‌های زمان‌دار و تحویل وب‌هوک

`[triggers] crons = ["*/5 * * * *"]` از قبل در `wrangler.toml` هست. همان tick این کارها را می‌کند:

1. ردیف‌هایِ رسیده به صفِ ارسال را تخلیه می‌کند (`20` ردیف در هر tick) — همین کار نامه‌های زمان‌دار را تحویل می‌کند و هر چه قطعی رله یا تمام شدن سهمیه عقب انداخته باشد را دوباره تلاش می‌کند؛
2. وب‌هوک‌های خروجیِ رسیده به نوبت را تحویل می‌کند (`25` مورد در هر tick، با backoff پلّه‌ای `8` مرحله‌ای)؛
3. ردیف‌های صف که از `queue_retention_days` (پیش‌فرض `14`) گذشته باشد را منقضی می‌کند و گزارش تحویل وب‌هوک را بعد از `7` روز پاک می‌کند؛
4. sessionهای منقضی‌شده را حذف می‌کند.

هر ردیف پیش از اینکه رویش کار شود قفل (lease) می‌خورد، به مدتِ ده دقیقه. بنابراین دو tickی که روی هم بیفتند — یا cronی که وقتی هنوز یک درخواست `/api/v1/send` در انتظار رله است شلیک کند — نمی‌توانند یک message را دو بار بفرستند. اگر tickی وسطِ ارسال کشته شود، فقط همان lease خرج شده است: ردیف دوباره نوبت می‌گیرد و تلاش می‌شود.

همان هر 5 دقیقه نگهش دار، مگر اینکه وب‌هوک‌ها سریع‌تر پخش شوند؛ `*/2 * * * *` هم فقط `720` فراخوانی در روز است، در برابر بودجهٔ `100,000` درخواست.

## 11. به پروژه‌های دیگرت دسترسی بده

این همان بخشی است که جای «روی سرور یک میل‌سرور نصب کن» را می‌گیرد.

در وب‌اپ: **Mail server → Project tokens → New token.** برایش یک نام، دامنه‌های دسترسی‌ای که لازم دارد (`send`، `read`، `status`)، یک سقف درخواست در دقیقه، یک بودجهٔ روزانه بگذار و اگر می‌خواهی نشانی‌های `from` مجاز را قفل کن. کلیدِ رمز (secret) را **یک بار** کپی کن — به‌صورت SHA-256 hash ذخیره می‌شود و دیگر قابل نمایش نیست.

بعد از هر پروژه‌ای:

```bash
curl -X POST https://jmail.<account>.workers.dev/api/v1/send \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"from":"alerts@yourdomain","to":["you@yourdomain"],"subject":"Deploy done","text":"prod is up"}'
```

مرجع کامل: [`API.md`](./API.md). نمونه‌های آماده برای Node، Python، PHP و cron، به‌علاوهٔ روایتِ مخصوص SMTP، در [`INTEGRATIONS.md`](./INTEGRATIONS.md) آمده‌اند.

## 12. اختیاری: hostname خودت به‌جای workers.dev

برای اینکه برنامه را روی `mail.yourdomain.com` سرو کنی — که cookie و مبدأ CORS را هم مرتب نگه می‌دارد — برای Worker یک Custom Domain در پیشخوان Cloudflare اضافه کن (`Workers & Pages → jmail → Settings → Domains & Routes`). خودِ Cloudflare آن CNAME را می‌سازد و آن route روی لایهٔ رایگان اجرا می‌شود.

`/api/v1/*` را از هر originی که پروژه‌هایت انتظار دارند قابل دسترسی بگذار؛ API جلوی **mutationهای** cross-origin را می‌گیرد، مگر اینکه Origin با مبدأِ درخواستِ فرستنده بخواند.

---

## 13. تأیید کن که کار می‌کند

این پنج بررسی را یکی‌یکی اجرا کن؛ هر کدام یک زیرسیستمِ متفاوت را به حرکت درمی‌آورد.

```bash
# 1. Worker alive + clock skew helper
curl -s https://jmail.<account>.workers.dev/api/health

# 2. Inbound: send mail from any external address to anything@yourdomain,
#    then look in the inbox. If it's missing, check the routing rule points at
#    the Worker and the MX records are live:
npx wrangler d1 execute jmail-db --remote --command \
  "SELECT id, type, from_address, to_address, created_at FROM emails ORDER BY created_at DESC LIMIT 5"

# 3. Outbound through a relay
curl -s -X POST https://jmail.<account>.workers.dev/api/v1/send \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"from":"alerts@yourdomain","to":["you@yourdomain"],"subject":"JMail test","text":"ok"}'

# 4. Which relay has room left today
curl -s https://jmail.<account>.workers.dev/api/v1/quota \
  -H "Authorization: Bearer <token>"

# 5. Queue actually draining? Watch a tick.
npx wrangler tail 2>/dev/null | grep cron
```

بعد برای خودت یک نامهٔ آزمایشی به یک نشانی Gmail بفرست و تأیید کن که **DKIM=PASS** است. همین یک چیز، بیش از هر عامل دیگری تعیین می‌کند که نامه‌ات در inbox می‌نشیند یا نه.

## 14. عیب‌یابی

| مشکل | علت | راه‌حل |
| --- | --- | --- |
| هیچ نامه‌ای به صندوق نمی‌رسد | MX هنوز منتشر نشده، catch-all خاموش است، یا قانون به نامِ Workerِ قدیمی اشاره می‌کند | در `Email Routing → Rules`: catch-all باید **Route to Worker** باشد و Worker باید `jmail` باشد. تغییرات مسیریابی ممکن است حدود 15 دقیقه طول بکشد تا اثر کنند. |
| catch-all تحویل می‌دهد اما نشانی‌ها `404` می‌گیرند | قانون به‌جای Worker به شکل `Forward to email` ساخته شده | wizard را دوباره اجرا کن، یا `curl -X POST -H "Authorization: Bearer <session token>" -d '{"workerName":"jmail"}' <origin>/api/setup/cloudflare/worker-routing` را بزن |
| ارسال با `status: queued` برمی‌گردد و هرگز `sent` نمی‌شود | رله‌ای تنظیم نشده، یا سهمیهٔ روزِ همهٔ رله‌ها تمام شده | `GET /api/v1/quota`. رله‌های رایگان در `00:00 UTC` ری‌ست می‌شوند؛ ردیف خودش روی نردبانِ تلاشِ دوباره امتحان می‌شود — چیزی از دست نمی‌رود. |
| رله در هر ارسال `401/403` می‌دهد | کلید عوض شده یا دامنه آن‌جا تأیید نشده | کلید را در Settings دوباره وارد کن؛ دامنهٔ ارسال را در پیشخوانِ همان رله تأیید کن. |
| نامه در spam با Gmail می‌نشیند | DKIM وجود ندارد یا SPF روی دو رکورد TXT تقسیم شده | SPF را در یک رکورد ادغام کن؛ CNAME مربوط به DKIM را تأیید کن؛ دامنهٔ بخش From را با دامنهٔ امضاکنندهٔ تأییدشده برابر نگه‌دار. |
| صندوق کند به نظر می‌رسد و مصرف فضای D1 بالا می‌رود | هر پیوست یک ردیف base64 در D1 است | R2 را فعال کن (بخش 9). |
| wizard رمز را نمی‌پذیرد | `SETUP_CODE` نمی‌خواند، یا راه‌اندازی قبلاً کامل شده | `wrangler secret list` را بررسی کن؛ `SELECT value FROM settings WHERE key='setup_completed'` باید چیزی برنگرداند یا `false` بدهد. |
| login با پیام `Too many attempts` بسته می‌شود | محدودکنندهٔ `5-per-15-minutes` (رمز و passkey این سهمیه را مشترک مصرف می‌کنند) | تا زمانِ `retryAfter` که نشان داده می‌شود صبر کن، یا `SELECT * FROM rate_limits` را نگاه کن. |
| پیوست‌های نامه‌های دریافتی نیستند | Cloudflare Email Routing اندازهٔ هر message را نزدیک `5 MiB` سقف می‌کند | چیزی برای درست کردن نیست — این سقفِ خودِ پلتفرم است؛ فایل‌های بزرگ را با لینک بفرست. |

## 15. پشتیبان‌گیری و کارهای دوره‌ای

کل صندوقِ تو یک فایل SQLite است:

```bash
npx wrangler d1 execute jmail-db --remote --command \
  "SELECT * FROM emails" > backup-emails.csv
# or a full export:
npx wrangler d1 export jmail-db --remote --output=backup-$(date +%F).sql
```

این را در یک cron هفتگی بگذار. این‌ها هم خوب است که بدانیشان:

- **رعایت حریم خصوصی (حس GDPR)**: در Settings مورد `queue_retention_days`، و صفحهٔ گرفتن خروجی از صندوق یک فایل `.mbox` قابل‌حمل می‌سازد.
- **ارتقا دادن**: `git pull && pnpm install && pnpm build && pnpm --filter
  @jmail/worker deploy`. روی یک پایگاه دادهٔ تازه `schema.sql` همهٔ جدول‌ها و نامِ ستون‌های فعلی را از قبل دارد، پس چیز دیگری لازم نیست؛ اما روی پایگاه داده‌ای که قبلاً deploy کرده بودی، فقط فایل‌های `src/db/migrations/` را اعمال کن که نداری — بخش [Upgrading](../README.md#upgrading) در README آن‌ها را به ترتیب، همراه با همان کوک (probe) که می‌گوید روی کدام نسل ایستاده‌ای، فهرست کرده است.
- **بازنشانی دسترسی ادمین** (رمز گم‌شده): hash و پرچمِ wizard در D1 زندگی می‌کنند — `DELETE FROM settings WHERE key='admin_password_hash'` و `DELETE FROM settings WHERE key='setup_completed'`، بعد برنامه را دوباره بارگذاری کن و setup را با `SETUP_CODE` خودت اجرا کن. توکن‌های API دست‌نخورده می‌مانند، و هر sessionی که از قبل صادر شده تا وقتی منقضی شود معتبر می‌ماند — اگر می‌خواهی همه را بیرون کنی، `DELETE FROM sessions` را هم بزن.
