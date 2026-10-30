# وصل کردن پروژه‌هایت به JMail

JMail همان میل‌سروری است که پروژه‌های دیگر تو با آن حرف می‌زنند. به‌جای اینکه روی هر ماشین postfix/exim/SMTP و اعتبارنامه‌هایش را نصب کنی، هر پروژه با توکن مخصوص خودش یک درخواست HTTPS به Worker می‌زند و نامه‌های ورودی به‌شکل یک وب‌هوک (webhook) یا یک poll به پروژه می‌رسند.

همه‌چیز این‌جا روی لایهٔ رایگان اجرا می‌شود. جزئیات endpointها در [`API.md`](./API.md) و امضای وب‌هوک‌ها در [`WEBHOOKS.md`](./WEBHOOKS.md) است.

**مسیرت را انتخاب کن**

| پروژه‌ات… | از این استفاده کن | برو به |
| --- | --- | --- |
| می‌تواند یک درخواست HTTP بزند | `POST /api/v1/send` | §2–§4 |
| فقط SMTP بلد است (WordPress، Laravel، `mail()` در PHP، یک build server) | پلِ SMTP | §6 |
| باید نامه‌های دریافتی را بخواند (صندوق پشتیبانی، پاسخ‌های تأیید) | `GET /api/v1/messages` یا وب‌هوک `received` | §5 |
| باید بداند نامه واقعاً رسیده یا نه | دامنهٔ دسترسی `status` + وب‌هوک‌ها | §7 |
| در CI اجرا می‌شود و نباید سهمیه را نابود کند | توکن با بودجهٔ روزانهٔ کوچک | §8 |

---

## 1. یک توکن برای هر پروژه

در اپ وب این مسیر را برو: **Mail server → Project tokens → New token**، یا این فرمان را بزن:

```bash
curl -sS -X POST "$JMAIL_URL/api/tokens" \
  -H "Authorization: Bearer $JMAIL_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"billing-app","scopes":["send","status"],"identity_address":"billing@yourdomain","rate_per_min":10,"daily_budget":200}'
```

پاسخ دقیقاً یک بار شامل `"secret"` است (با پیشوند `jmail_…`); این راز در دیتابیس فقط به‌شکل هش SHA-256 ذخیره می‌شود، پس اگر راز گم شود باید توکن جدیدی بسازی، نه اینکه بازیابی‌اش کنی.

| فیلد | از چه چیزی محافظت می‌کند |
| --- | --- |
| `scopes` | `send` نامه می‌فرستد، `read` نامه‌های ورودی را می‌خواند، `status` ارسال‌ها و سهمیهٔ خودِ توکن را پرس‌وجو می‌کند |
| `identity_address` | مقدار `from` را قفل می‌کند — توکن نمی‌تواند خود را یک آدرس دیگر جا بزند |
| `rate_per_min` | محدودسازِ هر توکن (1–120، پیش‌فرض 60)، تا یک حلقهٔ سرکش فقط damage همان پروژه را بالا ببرد |
| `daily_budget` | تعداد ارسالِ هر توکن در هر روز UTC (1–5000، پیش‌فرض 200)، جدا از سهمیهٔ رله |

پاسخ با کد `201` و ساختار `{ token, secret, warning }` برمی‌گردد؛ فقط `secret` یک بار نمایش داده می‌شود.

راز را در متغیر محیطی پروژه بگذار (`JMAIL_TOKEN`)، و هرگز در یک ریپو، یک اپ موبایل یا کد مرورگر قرار نده — بخش 9 را بخوان.

قبل از اینکه هر چیزی را وصل کنی، یک بررسی سریع:

```bash
curl -sS "$JMAIL_URL/api/v1/whoami" -H "Authorization: Bearer $JMAIL_TOKEN"
```

---

## 2. curl

```bash
export JMAIL_URL=https://jmail.your-account.workers.dev
export JMAIL_TOKEN=jmail_xxx

curl -sS -X POST "$JMAIL_URL/api/v1/send" \
  -H "Authorization: Bearer $JMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "alerts@yourdomain",
    "to": ["you@yourdomain"],
    "subject": "Deploy finished",
    "text": "prod is up.",
    "idempotency_key": "deploy-2026-10-28"
  }'
```

مقدار `"to"` همیشه یک آرایه است (آرایهٔ تک‌عضوی هم اشکال ندارد)، و `"from"` باید یا همان `identity` قفل‌شده روی توکن باشد یا آدرسی که در **Settings → Addresses** تعریف شده.

---

## 3. Node.js — یک کلاینت کامل، بدون هیچ وابستگی

این فایل را داخل پروژه بگذار و `JMAIL_URL` + `JMAIL_TOKEN` را ست کن.

```js
// jmail.mjs
const BASE = process.env.JMAIL_URL;
const TOKEN = process.env.JMAIL_TOKEN;

async function request(path, options = {}, attempt = 0) {
  const response = await fetch(`${BASE}/api/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers || {}),
    },
  });

  // 451-ish story: the API says when to come back, so honour it instead of
  // hammering a saturated free quota.
  if (response.status === 429 && attempt < 3) {
    const body = await response.json().catch(() => ({}));
    const wait = Number(body.retry_after || response.headers.get('retry-after') || 30);
    await new Promise(resolve => setTimeout(resolve, wait * 1000));
    return request(path, options, attempt + 1);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `http_${response.status}`);
    error.status = response.status;
    error.detail = body;
    throw error;
  }
  return body;
}

export const sendMail = (message) => request('send', {
  method: 'POST',
  body: JSON.stringify({
    from: message.from,
    to: [message.to].flat(),
    cc: message.cc ? [message.cc].flat() : undefined,
    bcc: message.bcc ? [message.bcc].flat() : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    reply_to: message.replyTo,
    send_at: message.sendAt,
    labels: message.labels,
    idempotency_key: message.idempotencyKey,
    attachments: message.attachments?.map(file => ({
      filename: file.filename,
      content: file.content.toString('base64'),
      content_type: file.contentType,
    })),
  }),
});

export const mailStatus = (id) => request(`messages/${id}`);
export const inbox = (query = '') => request(`messages?direction=inbound${query}`);
export const quota = () => request('quota');
```

استفاده‌اش:

```js
import { readFileSync } from 'node:fs';
import { sendMail } from './jmail.mjs';

const result = await sendMail({
  from: 'receipts@yourdomain',
  to: 'customer@example.org',
  subject: 'Your invoice',
  text: 'Thanks! Invoice #1042 is attached.',
  html: '<p>Thanks! Invoice <b>#1042</b> is attached.</p>',
  idempotencyKey: 'invoice-1042',          // retrying this send cannot double-bill
  attachments: [{
    filename: 'invoice-1042.pdf',
    content: readFileSync('./invoice-1042.pdf'),
    contentType: 'application/pdf',
  }],
});

console.log(result.id, result.status);       // status: sent | queued | deferred | failed
```

---

## 4. Python

```python
import os, time, requests

BASE = os.environ["JMAIL_URL"].rstrip("/")
TOKEN = os.environ["JMAIL_TOKEN"]

def send(**message):
    for attempt in range(4):
        response = requests.post(
            f"{BASE}/api/v1/send",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json={"from": "alerts@yourdomain", **message},
            timeout=15,
        )
        if response.status_code == 429:
            time.sleep(int(response.json().get("retry_after", 30)))
            continue
        response.raise_for_status()
        return response.json()
    raise RuntimeError("JMail is rate limiting us")

mail = send(to=["you@yourdomain"], subject="Job done", text="The nightly import finished.")
print(mail["id"], mail["status"])
```

… یا الگوی رایج در Django، که `EMAIL_FILE_BACKEND` را کاملاً جابه‌جا می‌کند:

```python
# views.py
from django.conf import settings
import requests

def notify(order):
    requests.post(
        f"{settings.JMAIL_URL}/api/v1/send",
        headers={"Authorization": f"Bearer {settings.JMAIL_TOKEN}"},
        json={
            "from": "shop@yourdomain",
            "to": [order.email],
            "subject": f"Order {order.id} shipped",
            "html": render_to_string("order_shipped.html", {"order": order}),
            "text": f"Order {order.id} shipped.",
            "idempotency_key": f"order-{order.id}-shipped",
        },
        timeout=15,
    ).raise_for_status()
```

نیازی به نسخهٔ فقط-stdlib نیست — ولی اگر نمی‌توانی `requests` را نصب کنی، `urllib.request` دقیقاً همان‌طور کار می‌کند:

```python
import json, os, urllib.request

def send(payload):
    request = urllib.request.Request(
        f"{os.environ['JMAIL_URL']}/api/v1/send",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {os.environ['JMAIL_TOKEN']}",
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)
```

---

## 5. PHP

یک تابع ساده:

```php
<?php
function jmail_send(array $message): array {
    $url = rtrim(getenv('JMAIL_URL'), '/') . '/api/v1/send';
    $handle = curl_init($url);
    curl_setopt_array($handle, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($message),
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . getenv('JMAIL_TOKEN'),
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($handle);
    if (curl_errno($handle)) throw new RuntimeException('JMail: ' . curl_error($handle));
    $status = curl_getinfo($handle, CURLINFO_HTTP_CODE);
    curl_close($handle);

    $payload = json_decode($body, true) ?? [];
    if ($status >= 400) throw new RuntimeException($payload['error'] ?? "JMail HTTP $status");
    return $payload;
}

jmail_send([
    'from' => 'form@yourdomain',
    'to' => ['you@yourdomain'],
    'subject' => 'Contact form',
    'text' => "Name: {$_POST['name']}\n{$_POST['message']}",
    'reply_to' => $_POST['email'],
]);
```

**Laravel.** ساده‌ترین مسیر برای Laravel همان SMTP است — نشانش بده پل (§6) و دست به `Mail::`هایت نزن. اگر ترجیح می‌دهی مستقیم API را صدا بزنی، یک transport بنویس:

```php
// app/Mail/JMailTransport.php
namespace App\Mail;

use Illuminate\Mail\Transport\Transport;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;

class JMailTransport extends Transport
{
    public function send(Email $email, array $sent = []): void
    {
        $list = fn ($addresses) => array_map(fn (Address $a) => $a->getAddress(), $addresses);

        $this->post([
            'from' => $email->getFrom()[0]?->getAddress(),
            'to' => array_merge($list($email->getTo()), $list($email->getCc())),
            'subject' => $email->getSubject(),
            'text' => $email->getTextBody(),
            'html' => $email->getHtmlBody(),
        ]);
    }

    private function post(array $payload): void
    {
        \Http::withToken(config('services.jmail.token'))
            ->post(rtrim(config('services.jmail.url'), '/') . '/api/v1/send', $payload)
            ->throw();
    }
}
```

ثبتش در `AppServiceProvider::boot()`:

```php
Illuminate\Support\Facades\Mail::extend('jmail', fn () => new App\Mail\JMailTransport());
```

و در `config/services.php` مقدار `MAIL_MAILER=jmail` به‌همراه `JMAIL_URL` / `JMAIL_TOKEN` را ست کن.

---

## 6. پروژه‌هایی که فقط SMTP بلدند: پل

بعضی چیزها اصلاً نمی‌شواند یک HTTP API صدا بزنند — WordPress با mailer پیش‌فرض، `mail()` در PHP، یک Postfix که گمان می‌کند خودش *همان* میل‌سرور است، یا یک ابزار گزارش‌گیری قدیمی. فایل `scripts/smtp-bridge.mjs` یک SMTP سرور کوچک است که نامه‌های آن‌ها را می‌پذیرد و به `/api/v1/send` هدایت می‌کند، تا JMail همان میل‌سرور واحدِ پشتِ همهٔ آن‌ها بماند.

```bash
JMAIL_API_URL=https://jmail.your-account.workers.dev \
JMAIL_TOKEN=jmail_xxx \
node scripts/smtp-bridge.mjs
# JMail SMTP bridge on 127.0.0.1:2525 -> https://…/api/v1/send
```

پل آن بخش‌هایی از SMTP را که در عمل اهمیت دارند می‌فهمد: `EHLO`/`HELO`، `MAIL FROM` (شامل reverse-path تهی `<>`)، `RCPT TO`، `DATA` با dot-unstuffing، `RSET`، `AUTH PLAIN`/`AUTH LOGIN`، `NOOP`، `QUIT`. در سمت MIME هم بدنه‌های base64 و quoted-printable را رمزگشایی می‌کند، هدرها را باز-خط‌بندی (unfold) و طبق RFC 2047 رمزگشایی می‌کند، `multipart/alternative` را به فیلدهای `text` و `html` در API تقسیم می‌کند، و `Cc`/`Bcc` را در فیلدهای مستقل خودشان می‌گذارد.

**متغیرهای محیط**

| متغیر | پیش‌فرض | معنا |
| --- | --- | --- |
| `JMAIL_API_URL` | `http://localhost:8787` | آدرس پایهٔ Worker (دقت کن: `JMAIL_API_URL`، نه `JMAIL_URL`) |
| `JMAIL_TOKEN` | — الزامی | توکن API همان پروژه |
| `JMAIL_SMTP_HOST` | `127.0.0.1` | آدرسی که پل روی آن bind می‌شود |
| `JMAIL_SMTP_PORT` | `2525` | پورت bind؛ اگر پل را transport خودِ ماشین کنی `25` |
| `JMAIL_SMTP_PASSWORD` | خالی | اگر ست شود، پل AUTH را تبلیغ و الزامی می‌کند |
| `JMAIL_SMTP_MAX_BYTES` | 4 MiB | نامهٔ بزرگ‌تر را با `552` رد می‌کند |
| `JMAIL_FROM` | خالی | یک هویتِ فرستنده را برای همهٔ نامه‌ها تحمیل می‌کند |

**معنای خطاها SMTP-صحیح است**، و همین چیزی است که front کردن یک صفِ واقعی را ایمن می‌کند: `429`های API (سقف نرخ یا بودجهٔ روزانه) و پاسخ‌های `5xx` به `451` تبدیل می‌شوند — خطای موقت، تا MTA سمت کلاینت بعداً دوباره تلاش کند؛ یک `400/403/422` به `550` تبدیل می‌شود — برگشتِ قطعی (bounce)، تا چیزی تا ابد دوباره‌تلاش نشود. صف خودِ JMail هم هر چیزی را که پذیرفته نگه می‌دارد.

### وصل کردنش

**WordPress** — در تنظیمات: *WP Mail SMTP* (یا یک mu-plugin)، یا بدون پلاگین:

```php
// wp-content/mu-plugins/jmail.php
add_action('phpmailer_init', function ($mailer) {
    $mailer->isSMTP();
    $mailer->Host = '127.0.0.1';
    $mailer->Port = 2525;
    $mailer->SMTPAuth = false;
    $mailer->From = 'site@yourdomain';
    $mailer->FromName = 'My Site';
});
```

**Laravel / Symfony** — در `config/mail.php` همان mailer نوع `smtp` می‌ماند:

```env
MAIL_MAILER=smtp
SMTP_HOST=127.0.0.1
SMTP_PORT=2525
SMTP_USERNAME=anything
SMTP_PASSWORD=sekret   # only if JMAIL_SMTP_PASSWORD is set
MAIL_FROM_ADDRESS=app@yourdomain
```

**smtplib پایتون**

```python
import smtplib
from email.message import EmailMessage

mail = EmailMessage()
mail["From"] = "reports@yourdomain"
mail["To"] = "you@yourdomain"
mail["Subject"] = "Weekly report"
mail.set_content("See the attached CSV.")
mail.add_attachment(open("report.csv", "rb").read(), maintype="text", subtype="csv", filename="report.csv")

with smtplib.SMTP("127.0.0.1", 2525) as server:
    server.send_message(mail)
```

**`mail()` در PHP** — به PHP یک sendmailِ SMTP-بلد بده. اگر `msmtp` نصب است:

```ini
; /etc/php/8.3/fpm/php.ini
sendmail_path = /usr/bin/msmtp -t --host=127.0.0.1 --port=2525 -f site@yourdomain
```

… یا پل را روی پورت 25 (یا 587) بگذار و در Postfix مقدار `relayhost = [127.0.0.1]:2525` را ست کن تا کل نامه‌های سرور از طریق JMail بیرون برود.

**واحد systemd** (`/etc/systemd/system/jmail-bridge.service`):

```ini
[Unit]
Description=JMail SMTP bridge
After=network-online.target

[Service]
EnvironmentFile=/etc/jmail-bridge.env
ExecStart=/usr/bin/node /opt/jmail/scripts/smtp-bridge.mjs
Restart=always
RestartSec=5
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now jmail-bridge
```

**آن را روی localhost نگه دار.** هر چیزی که به این پورت برسد می‌تواند به‌نیابت همان توکن نامه بفرستد. اگر مجبوری جای دیگری bind کنی، `JMAIL_SMTP_PASSWORD` را ست کن — و یک SSH tunnel یا یک رابط WireGuard را به bind کردن روی اینترفیس عمومی ترجیح بده.

---

## 7. وضعیت تحویل: اول وب‌هوک، بعد polling

رویدادهای [`WEBHOOKS.md`](./WEBHOOKS.md) (`sent`، `delivered`، `opened`، `bounced`) را عضو شو و `provider_message_id` را کنار رکورد خودت ذخیره کن. این مسیر push است، و همان چیزی است که وضعیت را رایگان می‌کند — بدون cron که سرِ API داد بزند.

اگر پروژه‌ای فقط دامنهٔ دسترسی `status` دارد، یا یک reconciler می‌خواهی:

```bash
# one message
curl -sS "$JMAIL_URL/api/v1/messages/<id>" -H "Authorization: Bearer $JMAIL_TOKEN"

# anything that never left the queue
curl -sS "$JMAIL_URL/api/v1/messages?status=deferred&limit=50" -H "Authorization: Bearer $JMAIL_TOKEN"

# did this specific business event get through?
curl -sS "$JMAIL_URL/api/v1/messages?idempotency_key=invoice-1042" -H "Authorization: Bearer $JMAIL_TOKEN"
```

هر توکن فقط نامه‌های خودش را می‌بیند، پس یک پروژهٔ به‌سررفتاده نمی‌تواند نامه‌های پروژهٔ دیگری را بخواند.

**وضعیت‌هایی که خواهی دید**

مسیر اصلی: `pending` → `queued` → `delivered` → `opened`، به‌همراه `deferred` (در حال دوباره‌تلاش، چیزی از دست نرفته)، `bounced` (آدرس مرده است) و `failed` (بی‌خیال شده: رد شدنِ قطعی از سمت رله، یا تمام شدن نردبان تلاش‌های مجدد — و بعد از آن `queue_retention_days`).

---

## 8. خواندن نامه‌های دریافتی (صندوق پشتیبانی، تأیید از راه پاسخ)

به توکن دامنهٔ دسترسی `read` بده و poll کن:

```bash
curl -sS "$JMAIL_URL/api/v1/messages?direction=inbound&unread=true&limit=20" \
  -H "Authorization: Bearer $JMAIL_TOKEN"
```

```python
import requests

def ticket_from(message):
    body = requests.get(
        f"{BASE}/api/v1/messages/{message['id']}",
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=15,
    ).json()
    return body  # includes `text`/`html`, `headers`, `attachments`, `thread_id`

def poll_unread():
    listing = requests.get(
        f"{BASE}/api/v1/messages",
        params={"direction": "inbound", "unread": "true", "limit": 25},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=15,
    ).json()["messages"]

    for item in listing:
        ticket = ticket_from(item)
        create_ticket(ticket)
        # threading: reply with the original `message_id` as In-Reply-To
        send(to=[ticket["from"]], subject=f"Re: {ticket['subject']}", text="We're on it.")
        requests.post(f"{BASE}/api/v1/messages/{item['id']}/read",
                      headers={"Authorization": f"Bearer {TOKEN}"}, timeout=15)
```

بایت‌های پیوست:

```bash
curl -sS -o invoice.pdf "$JMAIL_URL/api/v1/messages/<id>/attachments/<attachmentId>" \
  -H "Authorization: Bearer $JMAIL_TOKEN"
```

برای هر چیزی که به تأخیر حساس است وب‌هوک `received` را ترجیح بده؛ polling برای یک cron چند-دقیقه‌ای کاملاً خوب است و integration را بی‌حالت (stateless) نگه می‌دارد. سقف پلتفرم را یاد داشته باش: Email Routing فقط نامه‌هایی تا حدود 5 MiB را تحویل می‌دهد.

---

## 9. قاعده‌هایی که همه‌چیز را ساده و بی‌دردسر نگه می‌دارند

- **هرگز از مرورگر یا اپ موبایل API را صدا نزن.** توکن عمومی می‌شد، و API هم در هر صورت درخواست‌های تغییردهندهٔ cross-origin را رد می‌کند. بک‌اند تو JMail را صدا می‌زند؛ کلاینت بک‌اند خودت را.
- **`from` را از ورودی کاربر نگیر.** برای هر توکن یک `identity_address` قفل کن و بگذار JMail خودش پر کند. برای آدرس کاربر از `reply_to` استفاده کن.
- **یک توکن برای هر پروژه.** `rate_per_min` و `daily_budget` همان چیزی است که نمی‌گذارد یک باگ در پروژهٔ A کل سهمیهٔ رایگانِ روزت را بخورد.
- **کلیدهای خودتوانی شناسهٔ کسب‌وکارند** — `invoice-1042`، `order-9021-shipped` — نه UUIDهای تصادفی. همین است که یک تلاشِ مجدد را ایمن می‌کند.
- **`429` را «بخواب و دوباره تلاش کن» بگیر**، و `422` را «نامه غلط است، کد را درست کن».
- **قبل از یک اجرای بزرگ `GET /api/v1/quota` را چک کن**: `total_remaining_today` مجموع همان چیزی است که رله‌های پیکربندی‌شده هنوز اجازه می‌دهند.
- رله‌های رایگان سرِ **00:00 UTC** صفر می‌شوند. نامه‌ای که در روزِ تمام‌شده ارسال شود *deferred* می‌شود، دور ریخته نمی‌شود، و در تیک بعدی cron بیرون می‌رود — ولی اگر اپت تحویلِ فوری در ساعت 23:55 می‌خواهد، همان ساعتی است که باید درباره‌اش بدانی.

---

## 10. دستورهای آمادهٔ کپی-چسبانی

**GitHub Actions — اطلاع‌رسانی در صورت شکست deploy**

```yaml
- name: Mail me
  if: failure()
  env:
    JMAIL_URL: ${{ vars.JMAIL_URL }}
    JMAIL_TOKEN: ${{ secrets.JMAIL_TOKEN }}
  run: |
    curl -fsS -X POST "$JMAIL_URL/api/v1/send" \
      -H "Authorization: Bearer $JMAIL_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"from\":\"ci@yourdomain\",\"to\":[\"you@yourdomain\"],\"subject\":\"${GITHUB_REPOSITORY} failed\",\"text\":\"Run ${GITHUB_RUN_ID}\",\"idempotency_key\":\"${GITHUB_RUN_ID}\"}"
```

**cron / anacron — گزارش پشتیبان‌گیری شبانه**

```sh
#!/bin/sh
set -eu
STATUS=$(pg_backup || echo failed)
curl -fsS -X POST "$JMAIL_URL/api/v1/send" \
  -H "Authorization: Bearer $JMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"backup@yourdomain\",\"to\":[\"you@yourdomain\"],\"subject\":\"Backup $STATUS\",\"text\":\"$(date -Is)\",\"idempotency_key\":\"backup-$(date +%F)\"}"
```

کلید به شکل `backup-YYYY-MM-DD` است، پس اجرای دوبارهٔ همان کارِ روز نمی‌تواند دو بار نامه بفرستد.

**ارسال زمان‌دار — یک یادآور برای دو روز بعد**

```bash
curl -sS -X POST "$JMAIL_URL/api/v1/send" \
  -H "Authorization: Bearer $JMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"you@yourdomain","to":["you@yourdomain"],"subject":"Renew the domain","text":"due 2026-11-01","send_at":"2026-10-31T09:00:00Z"}'
```

`send_at` در آینده پاسخ `202 queued_for:<when>` برمی‌گرداند و cron سرِ وقتش تحویل می‌دهد؛ همان ردیف در دیتابیس از قطعیِ رله هم جان سالم به در می‌برد و روی نردبان تلاشِ مجدد دوباره تلاش می‌شود.

**ارسال ورودی یک فرم به سه نفر، با یک درخواست**

```json
{
  "from": "form@yourdomain",
  "to": ["sales@yourdomain", "founder@yourdomain"],
  "cc": ["crm@example-tool.com"],
  "subject": "New lead",
  "html": "<p><b>Jane</b> asked about the annual plan.</p>",
  "text": "Jane asked about the annual plan.",
  "reply_to": "jane@example.org"
}
```
