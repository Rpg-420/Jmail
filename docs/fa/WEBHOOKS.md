# وب‌هوک‌ها: بگذار جی‌میل پروژهٔ تو را صدا بزند

وب‌هوک راهی است که میل‌سرور از طریق آن به پروژهٔ تو می‌گوید چه بر سرِ نامه‌ای که ثبت کرده آمده — یا اینکه نامهٔ تازه‌ای در صندوقی که به‌عنوان صندوق ورودی به کار می‌بری رسیده است. پروژهٔ تو polling نمی‌کند؛ فقط یک endpoint روی HTTPS باز می‌کند و جی‌میل JSON امضاشده را به آن POST می‌کند.

endpointها را در UI از بخش **Mail server → Webhooks** ثبت کن، یا با admin API:

| فراخوانی | کاربرد |
| --- | --- |
| `GET /api/hooks` | فهرست endpointها (secret پوشیده می‌شود) |
| `POST /api/hooks` | ساخت — بدنه `{url, events?, token_id?}`؛ secret را **یک‌بار** برمی‌گرداند |
| `PUT /api/hooks/:id` | به‌روزرسانی url / events / active |
| `POST /api/hooks/:id/rotate-secret` | secret تازه؛ امضاهای قدیمی دیگر تأیید نمی‌شوند |
| `POST /api/hooks/:id/test` | یک رویداد ساختگی را در صف بگذار و فوراً تحویل بده |
| `GET /api/hooks/:id/deliveries` | 50 تلاش آخر با status و خطا |
| `DELETE /api/hooks/:id` | حذف endpoint |

`token_id` یک endpoint را فقط به رویدادهای تولیدشده توسط یک integration token محدود می‌کند — معمولاً همان چیزی که می‌خواهی، تا برنامهٔ صورتحساب از نامه‌های وبلاگ باخبر نشود.

---

## 1. ساختار درخواست

```http
POST /your/webhook/handler HTTPS
User-Agent: JMail-Webhook/1.0
X-JMail-Event: sent
X-JMail-Delivery: 9f2c…               # unique per attempt target, stable across retries
X-JMail-Signature: t=1761686400,v1=5257a869e1…   # 64 hex chars
Content-Type: application/json
```

```json
{
  "id": "9f2c…",
  "type": "sent",
  "occurred_at": "2026-10-28T09:12:33.000Z",
  "data": {
    "id": "0f5c…",
    "to": "customer@example.com",
    "subject": "Invoice 42",
    "provider": "brevo",
    "provider_message_id": "<invoice-42@example.com>",
    "token_id": "tok_1"
  }
}
```

### رویدادها

| رویداد | `data` شامل | چه زمانی صادر می‌شود |
| --- | --- | --- |
| `sent` | `id, to, subject, provider, provider_message_id, token_id` | یک رله پیام را پذیرفت |
| `delivered` | `id, to, recipient, subject, provider, provider_message_id, status, token_id` | رله تحویل را گزارش کرد |
| `opened` | همان `delivered` | رله یک open یا یک click را گزارش کرد |
| `bounced` | همان `delivered` | رله یک hard bounce، block یا نشانی نامعتبر را گزارش کرد |
| `deferred` | همان `delivered` | رله یک soft bounce یا tobeh‌بودن (deferral) را گزارش کرد |
| `failed` | `id, to, subject, error, attempts, token_id` | رد شدنِ دائم، یا پایان‌یافتن نردبان دوباره‌تلاش |
| `received` | `id, from, to, subject, preview, attachments, received_at` | نامهٔ inbound در یک صندوق ثبت شد |

چهار رویدادِ گزارش‌شده توسط رله (`delivered`، `opened`، `bounced`، `deferred`) از وب‌هوکِ خودِ رله می‌آیند. جی‌میل در جادویِ setup (مرحلهٔ راه‌اندازی) آن را روی رله ثبت می‌کند (`api/setup.ts` → `ensureBrevoWebhook`)، به سمت `POST /api/webhooks/brevo/<secret>` روی همین worker، که در آن `<secret>` همان ردیف `brevo_webhook_secret` در جدول `settings` است. API این مقدار را پوشیده نشان می‌دهد، پس اگر ثبت خودکار شکست خورد و خواستی وب‌هوک را دستی در داشبوردِ رله اضافه کنی، مقدارش را مستقیم از D1 بخوان:

```bash
wrangler d1 execute jmail-db --remote \
  --command "SELECT value FROM settings WHERE key = 'brevo_webhook_secret'"
```

سپس `https://<your-worker-origin>/api/webhooks/brevo/<that-value>` را برای رویدادهای `request`، `delivered`، `hardBounce`، `softBounce`، `blocked`، `invalid_email`، `deferred` و `uniqueOpened` ثبت کن. تا وقتی این کار را نکنی، همچنان `sent`، `failed` و `received` را می‌گیری، ولی هیچ‌چیزِ میانی را. گزارش‌های خارج از ترتیب هرگز وضعیت را پایین نمی‌آورند: `queued → deferred → delivered → opened` فقط به جلو حرکت می‌کند.

رویداد `received` همان چیزی است که جی‌میل را به یک میل‌سرور *inbound* قابل‌استفاده برای پروژه‌ات تبدیل می‌کند: یک قاعدهٔ Email Routing را به worker هدایت کن، `received` را subscribe کن، و برنامه‌ات نامه‌های تازه را به‌شکل یک درخواست HTTP امضاشده می‌گیرد.

---

## 2. بررسی امضا

امضا کل `<timestamp>.<raw body>` را می‌پوشاند. پیش از تجزیهٔ JSON آن را با secret خودِ endpoint بررسی کن، و timestampهای قدیمی‌تر از چند دقیقه را رد کن تا یک درخواستِ ضبط‌شده نتواند دوباره replay شود.

**بایت‌های خام را بخوان.** هر frameworkی که بدنهٔ تجزیه‌شده را دوباره سریال‌ایز (re-serialise) کند، یک کاراکتر را عوض می‌کند و HMAC را می‌شکند.

### Node / Express

```js
import crypto from 'node:crypto';
import express from 'express';

const SECRET = process.env.JMAIL_WEBHOOK_SECRET;
const app = express();

app.post('/hooks/jmail', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.headers['x-jmail-signature'];
  if (!verify(header, req.body, SECRET)) return res.status(400).send('bad signature');

  const event = JSON.parse(req.body.toString('utf8'));
  if (event.type === 'received') handleInboundMail(event.data);
  if (event.type === 'failed') markDeliveryFailed(event.data.id);

  res.status(200).send('ok');   // any 2xx counts as delivered
});

function verify(header, rawBody, secret) {
  const parts = Object.fromEntries(
    String(header ?? '').split(',').map(piece => {
      const at = piece.indexOf('=');
      return [piece.slice(0, at).trim(), piece.slice(at + 1).trim()];
    }).filter(([key]) => key)
  );
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;   // 5 min clock skew

  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
  if (parts.v1.length !== expected.length) return false;   // timingSafeEqual throws on unequal lengths
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

### Python / FastAPI

```python
import hashlib, hmac, time
from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()
SECRET = "whsec_…".encode()

@app.post("/hooks/jmail")
async def jmail_hook(request: Request, x_jmail_signature: str = Header(...)):
    body = await request.body()
    parts = dict(p.split("=", 1) for p in x_jmail_signature.split(","))
    if abs(time.time() - int(parts["t"])) > 300:
        raise HTTPException(400, "stale webhook")

    expected = hmac.new(SECRET, f'{parts["t"]}.{body.decode()}'.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, parts["v1"]):
        raise HTTPException(400, "bad signature")

    event = await request.json()
    if event["type"] == "received":
        handle_inbound_mail(event["data"])
    return {"ok": True}
```

### PHP / Laravel

Route (روی این path هیچ middleware مربوط به CSRF نباشد — آن را به استثناهای `bootstrap/app.php` اضافه کن):

```php
Route::post('/hooks/jmail', JmailWebhookController::class)->middleware('api');
```

```php
public function __invoke(Request $request): JsonResponse
{
    $secret = config('services.jmail.webhook_secret');
    $raw    = $request->getContent();
    $header = $request->header('X-JMail-Signature', '');

    parse_str(str_replace(',', '&', $header), $parts);
    if (abs(time() - (int) ($parts['t'] ?? 0)) > 300) abort(400, 'stale webhook');

    $expected = hash_hmac('sha256', $parts['t'].'.'.$raw, $secret);
    if (!hash_equals($expected, $parts['v1'] ?? '')) abort(400, 'bad signature');

    $event = json_decode($raw, true);
    match ($event['type']) {
        'received' => $this->handleInboundMail($event['data']),
        'failed'   => $this->markDeliveryFailed($event['data']['id']),
        default    => null,
    };

    return response()->json(['ok' => true]);
}
```

---

## 3. ضمانت‌های تحویل

| رفتار | جزئیات |
| --- | --- |
| محرک (Trigger) | Cron، به‌طور پیش‌فرض هر 5 دقیقه |
| نردبان دوباره‌تلاش | 15 ثانیه، 1 دقیقه، 5 دقیقه، 30 دقیقه، 2 ساعت، 6 ساعت، 24 ساعت، 48 ساعت — 8 تلاش، سپس `failed` |
| موفقیت | هر پاسخ 2xx؛ ردیف بسته می‌شود |
| شکست دائمی | هر 4xx به‌جز `408` و `429` — یک handlerِ خراب دوباره‌تلاش نمی‌شود |
| قابلِ دوباره‌تلاش | `5xx`، timeoutها (10 ثانیه)، خطاهای اتصال، `429` |
| ترتیب | تضمین‌شده نیست. دو رویداد برای یک نامه می‌تواند به هر ترتیبی برسد |
| تکراری‌شدن | نادر (تحویلی درست پیش از پنجرهٔ دوباره‌تلاشِ خودش شروع شده باشد). با `X-JMail-Delivery` / `id` dedupe کن |

پس: سریع `200` جواب بده، کار را به‌صورت async انجام بده، و `id` را کلید dedupe خودت بدان.

**تأخیر.** رویدادها تا tick بعدی cron در صف (queue) می‌مانند — تا 5 دقیقه پس از ارسال. اگر زودترشان را می‌خواهی، در `wrangler.toml` cron را روی `*/2 * * * *` بگذار. تحویل `sent`/`failed` برای یک `/send` درون‌درخواستی در همان صدا queue می‌شود، پس مثل بقیه روی tick بعدی می‌نشیند.

---

## 4. قاعده‌های URL نشانیِ endpoint

- `https://` به‌شدت ارجح است؛ `http://` خالی فقط برای میزبان‌های عمومی پذیرفته می‌شود.
- نشانی‌های loopback، خصوصی، link-local، multicast و رزروشده رد می‌شوند (`127.0.0.1`، `10.*`، `172.16–31.*`، `192.168.*`، `169.254.*`، `::1`، `fc00::/7`، `fe80::/10`، …) و همینطور `localhost`، `*.internal`، `*.local`، credentialها داخل URL، و schemeهای غیر HTTP. این قاعده نمی‌گذارد میل‌سروری روی یک شبکهٔ مشترک، به یک اسکنر پورت داخلی تبدیل شود.
- hostnameای که *resolve شدنش* به نشانی خصوصی بینجامد، بدون اینکه خودت DNS lookup انجام دهی قابل تشخیص نیست؛ اگر در محیط تو اهمیت دارد، endpoint را پشت proxy‌ای اجرا کن که این را تحمیل کند.

---

## 5. آزمایش یک hook

1. **Mail server → Webhooks → Test** یک رویداد ساختگی برای endpoint در صف می‌کند و درون همان درخواست تحویلش می‌دهد، پس پاسخ به تو می‌گوید که handler چه وضعیت HTTP و چه متن خطایی برگردانده است.
2. یا وقتی endpoint ساخته شد، یکی را با curl دستی بساز — UI همان secret پوشیده (masked) را نشان می‌دهد؛ secret کامل فقط و فقط هنگام ساخت نمایش داده می‌شود، پس اگر گم‌اش کردی rotate‌اش کن:

```bash
BODY='{"id":"manual-1","type":"sent","occurred_at":"2026-10-28T09:00:00Z","data":{"id":"mail_1","to":"you@example.com","subject":"test"}}'
TS=$(date +%s)
SIG="t=${TS},v1=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-JMail-Event: sent" \
  -H "X-JMail-Delivery: manual-1" \
  -H "X-JMail-Signature: $SIG" \
  --data "$BODY"
```

اگر handler تو اینجا `200` برمی‌گرداند ولی از ارسال‌های واقعی هیچ خبری نمی‌رسد، یعنی endpoint به آن رویداد subscribe نکرده، یا فیلتر `token_id` آن را کنار زده است.
