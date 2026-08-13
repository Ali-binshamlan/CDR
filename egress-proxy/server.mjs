import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { request as httpsRequest } from 'node:https';

// =====================================================================
// وكيل خروج (Egress Proxy) — القسم 8 من مراجعة الخبير الخارجي:
// "استخدام Egress Proxy/Resolver موثوق مع مهلة إجمالية للطلب."
//
// خطأ مكتشَف ومُصلَح (تجربة نشر فعلية على Fly.io): النسخة الأولى من هذا
// الوكيل استخدمت بروتوكول HTTP CONNECT (بروتوكول forward-proxy القياسي) —
// اتضح أن الطبقة الخارجية لـFly.io (وربما منصات استضافة Serverless/PaaS
// أخرى مشابهة) لا تُمرِّر طلبات CONNECT للتطبيق المستضاف إطلاقاً (تُرفَض
// بـ502 على مستوى Fly نفسها، بلا أي أثر في سجلات هذا التطبيق). الحل: وكيل
// HTTP عادي (POST بصيغة JSON) بدل CONNECT — يعمل مع أي منصة استضافة تدعم
// استقبال طلبات HTTP قياسية (وهذا يشمل عملياً كل المنصات).
//
// كيف يعمل: يستقبل POST واحد يحمل {url, method, headers, body} — يحل DNS
// للنطاق المطلوب، يتحقق أن العنوان المُحلَّل ليس خاصاً/محجوزاً، ثم يتصل
// بنفس ذلك العنوان مباشرة (لا استعلام DNS ثانٍ بين الفحص والاتصال، فلا فجوة
// زمنية لهجوم DNS rebinding). يفرض مهلة إجمالية واحدة تغطي الفحص + الاتصال
// + الاستجابة كاملة.
// =====================================================================

const PROXY_PORT = Number(process.env.PORT) || 8080;
const PROXY_AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN;
const TOTAL_REQUEST_TIMEOUT_MS = Number(process.env.TOTAL_REQUEST_TIMEOUT_MS) || 10_000;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024; // 2MB — يكفي لأي حمولة login/telemetry فعلية
const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024; // 4MB

if (!PROXY_AUTH_TOKEN) {
  console.error('PROXY_AUTH_TOKEN غير مُعرَّف — الوكيل يرفض العمل بلا مصادقة (لا يجوز أن يكون وكيلاً عاماً مفتوحاً للجميع).');
  process.exit(1);
}

// نفس منطق isPrivateOrReservedIP في app/lib/providers/safeUrl.ts بالضبط —
// مكرَّر هنا عمداً (هذا مشروع منفصل تماماً، بلا استيراد مشترك عبر حدود
// النشر) لضمان نفس معايير الرفض على الطبقتين.
function isPrivateOrReservedIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  return false;
}

function isPrivateOrReservedIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('ff')) return true;
  const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted && isPrivateOrReservedIPv4(mappedDotted[1])) return true;
  return false;
}

function isPrivateOrReservedIP(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateOrReservedIPv4(ip);
  if (family === 6) return isPrivateOrReservedIPv6(ip);
  return true; // ليس IP صالحاً — فشل آمن نحو الرفض
}

function isAuthorized(req) {
  const header = req.headers['authorization'] || '';
  const expected = `Bearer ${PROXY_AUTH_TOKEN}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('حجم الطلب يتجاوز الحد المسموح');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// يحل DNS ويتحقق من الأمان، ثم يعيد العنوان الآمن الوحيد المسموح
// بالاتصال به — يُستدعى مباشرة قبل فتح الاتصال الفعلي بلا أي استعلام DNS
// وسيط آخر بينهما.
async function resolveSafeAddress(hostname) {
  if (net.isIP(hostname) !== 0) {
    if (isPrivateOrReservedIP(hostname)) {
      throw new Error('عنوان شبكة داخلي غير مسموح');
    }
    return hostname;
  }
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  const publicAddress = results.find((r) => !isPrivateOrReservedIP(r.address));
  if (!publicAddress) {
    throw new Error('لم يُعثَر على عنوان عام آمن لهذا النطاق');
  }
  return publicAddress.address;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/fetch') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'هذا الوكيل يخدم فقط POST /fetch' }));
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const overallController = new AbortController();
  const overallTimeout = setTimeout(() => overallController.abort(), TOTAL_REQUEST_TIMEOUT_MS);

  try {
    const rawBody = await readBody(req, MAX_REQUEST_BODY_BYTES);
    const payload = JSON.parse(rawBody.toString('utf8'));
    const { url: targetUrl, method = 'GET', headers = {}, body: targetBody } = payload;

    if (!targetUrl || typeof targetUrl !== 'string') {
      throw new Error('url مطلوب في جسم الطلب');
    }

    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error('يُسمَح فقط بروابط https');
    }

    // الفحص والاتصال في نفس الاستدعاء — لا فجوة زمنية بينهما.
    const safeAddress = await resolveSafeAddress(parsed.hostname);

    const responseBody = await new Promise((resolve, reject) => {
      const requestFn = httpsRequest;
      const upstreamReq = requestFn(
        {
          host: safeAddress,
          port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          method,
          headers: { ...headers, host: parsed.hostname },
          servername: parsed.hostname, // التحقق من شهادة TLS يبقى باسم النطاق الأصلي رغم الاتصال بعنوان IP مباشر
          signal: overallController.signal,
        },
        (upstreamRes) => {
          const chunks = [];
          let total = 0;
          upstreamRes.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_RESPONSE_BODY_BYTES) {
              upstreamReq.destroy(new Error('حجم الاستجابة يتجاوز الحد المسموح'));
              return;
            }
            chunks.push(chunk);
          });
          upstreamRes.on('end', () => {
            resolve({
              status: upstreamRes.statusCode,
              headers: upstreamRes.headers,
              body: Buffer.concat(chunks).toString('base64'),
            });
          });
          upstreamRes.on('error', reject);
        }
      );
      upstreamReq.on('error', reject);
      if (targetBody) upstreamReq.write(Buffer.from(targetBody, 'base64'));
      upstreamReq.end();
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  } finally {
    clearTimeout(overallTimeout);
  }
});

server.listen(PROXY_PORT, () => {
  console.log(`Egress proxy (HTTP forward mode) listening on port ${PROXY_PORT}`);
});
