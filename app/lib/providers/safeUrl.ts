import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// حماية SSRF لأي base_url خارجي (الآن يأتي حصراً من provider_instances
// المعتمدة من مسؤول النظام، لا من إدخال مستخدم حر — راجع القسم 15.1 من
// "دليل الإصلاح الجذري لمنظومة مرقاب") — بلا هذا الفحص، أي طلب للمنصة
// يقدر يستهدف عناوين شبكة داخلية (169.254.169.254 لخدمة meta-data
// السحابية، localhost، شبكات 10.x/172.16-31.x/192.168.x الخاصة) بدل منصة
// حقيقية. يُستدعى عند testConnection/listStations/fetchLatestReading
// جميعاً، لا عند الحفظ فقط (رابط قد يكون آمناً وقت الحفظ ثم يُغيَّر DNS
// لاحقاً — DNS rebinding).

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '::1', '[::1]']);

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — يشمل metadata السحابية
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  // CGNAT (100.64.0.0/10) — القسم 18.7 من التقرير الإيضاحي.
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Multicast (224.0.0.0/4) وDocumentation (192.0.2.0/24, 198.51.100.0/24,
  // 203.0.113.0/24) وReserved (240.0.0.0/4).
  if (a >= 224) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  return false;
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true; // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local (fc00::/7)
  if (normalized.startsWith('ff')) return true; // multicast (ff00::/8)

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — يُفحَص الجزء IPv4 المُضمَّن أيضاً.
  // الصيغة المنقوطة (::ffff:127.0.0.1) ممكنة من مصادر خام، لكن new URL()
  // يُطبِّعها لصيغة hex groups (::ffff:7f00:1) — كلا الشكلين يُفحَصان.
  const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted && isPrivateOrReservedIPv4(mappedDotted[1])) return true;

  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
    if (isPrivateOrReservedIPv4(dotted)) return true;
  }

  return false;
}

function isPrivateOrReservedIP(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateOrReservedIPv4(ip);
  if (family === 6) return isPrivateOrReservedIPv6(ip);
  return true; // ليس IP صالحاً أصلاً — فشل آمن نحو الرفض
}

export class UnsafeExternalUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeExternalUrlError';
  }
}

// يتحقق من رابط قبل أي استخدام فعلي في fetch — يرمي UnsafeExternalUrlError
// عند الرفض. يحل DNS فعلياً (لا يكتفي بفحص الشكل النصي) لمنع اسم نطاق عام
// يُحلّ إلى IP داخلي (DNS rebinding). https فقط الآن (القسم 15.1 — "منع
// http مطلقاً؛ لا ترسل اسم مستخدم وكلمة مرور عبر http").
export async function assertSafeExternalUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeExternalUrlError('رابط المنصة غير صالح');
  }

  if (parsed.protocol !== 'https:') {
    throw new UnsafeExternalUrlError('رابط المنصة يجب أن يكون https فقط');
  }

  if (parsed.username || parsed.password) {
    throw new UnsafeExternalUrlError('لا يجوز تضمين اسم مستخدم/كلمة مرور داخل الرابط نفسه');
  }

  if (parsed.port && parsed.port !== '443') {
    throw new UnsafeExternalUrlError('المنفذ المسموح 443 فقط');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new UnsafeExternalUrlError('رابط المنصة يشير لعنوان شبكة داخلي غير مسموح');
  }

  // hostname قد يكون IP حرفياً (بلا DNS) — يُفحص مباشرة بلا استعلام.
  if (isIP(hostname) !== 0) {
    if (isPrivateOrReservedIP(hostname)) {
      throw new UnsafeExternalUrlError('رابط المنصة يشير لعنوان شبكة داخلي غير مسموح');
    }
    return;
  }

  let addresses: string[];
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new UnsafeExternalUrlError('تعذّر تحليل اسم نطاق رابط المنصة');
  }

  if (addresses.length === 0 || addresses.some(isPrivateOrReservedIP)) {
    throw new UnsafeExternalUrlError('رابط المنصة يشير لعنوان شبكة داخلي غير مسموح');
  }
}

// خطأ أمني مكتشَف ومُصلَح (القسم 15.1/18.7 — "TOCTOU/DNS rebinding": ترك
// fetch يحل الاسم مرة أخرى بعد assertSafeExternalUrl يبقي فجوة؛ fetch()
// أيضاً يتبع تحويلات (redirect) تلقائياً بلا أي فحص على الوجهة الجديدة).
// safeFetch تحل محل fetch() المباشر لكل استدعاء Connector خارجي:
//   1. تتحقق من الرابط (نفس assertSafeExternalUrl) قبل كل محاولة اتصال —
//      بما فيها كل قفزة تحويل (redirect: 'manual' + فحص كل Location يدوياً
//      قبل اتّباعه، بدل السماح لـfetch بمتابعتها تلقائياً بلا تحقق).
//   2. تفرض Timeout قصير (AbortSignal.timeout).
//   3. تُحدِّد حداً أقصى لعدد التحويلات المتبوعة (5) لمنع حلقة تحويل لا
//      نهائية.
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 7000;

// وكيل خروج اختياري (القسم 8 — "استخدام Egress Proxy/Resolver موثوق"):
// egress-proxy/server.mjs (مشروع منفصل يُنشَر مستقلاً على Fly.io أو مشابه)
// يحل DNS ويتصل بنفس العنوان المفحوص في نفس اللحظة، فيغلق الفجوة الزمنية
// المتبقية بين فحص assertSafeExternalUrl هنا واتصال fetch الفعلي (نافذة
// DNS rebinding نظرية). يبقى فحص SSRF المحلي أعلاه كطبقة حماية إضافية حتى
// مع الوكيل مفعَّلاً. EGRESS_PROXY_URL غير مُعرَّف (مثال: التطوير المحلي)
// يعني الاستمرار بالسلوك الحالي (fetch مباشر) بلا كسر أي بيئة لم تُهيَّأ
// بعد بالوكيل.
//
// خطأ مكتشَف ومُصلَح (تجربة نشر فعلية على Fly.io): بروتوكول HTTP CONNECT
// القياسي (عبر undici ProxyAgent) لا يُمرَّر فعلياً عبر الطبقة الخارجية
// لـFly.io (يُرفَض بـ502 على مستوى المنصة نفسها، قبل وصول الطلب لتطبيق
// الوكيل، فلا يظهر أي أثر في سجلاته). البديل المتوافق مع منصات الاستضافة
// العادية: POST عادي بصيغة JSON ({url, method, headers, body}) بدل CONNECT
// — الوكيل يؤدي نفس الدور بالضبط (فحص DNS + اتصال في نفس اللحظة)، لكن
// بواجهة HTTP قياسية لا تتطلب أي دعم خاص من منصة الاستضافة.
const EGRESS_PROXY_URL = process.env.EGRESS_PROXY_URL; // مثال: https://dcr-egress-proxy.fly.dev/fetch
const EGRESS_PROXY_TOKEN = process.env.EGRESS_PROXY_TOKEN;

interface ProxiedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string; // base64
}

// يبني Response قياسي (نفس واجهة fetch العادية) من رد الوكيل — الدالة
// المستدعية (safeFetch أدناه) تستهلك response.status/response.headers.get
// فقط، فهذا كافٍ تماماً بلا حاجة لإعادة بناء Response كاملة بكل تعقيداتها.
function buildResponseFromProxyReply(reply: ProxiedResponse): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(reply.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const bodyBytes = Buffer.from(reply.body, 'base64');
  return new Response(bodyBytes, { status: reply.status, headers });
}

// يرسل الطلب عبر egress-proxy بدل fetch المباشر — يحوّل RequestInit إلى
// حمولة JSON بسيطة ({url, method, headers, body}) يفهمها server.mjs.
async function fetchViaEgressProxy(targetUrl: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const headersObject: Record<string, string> = {};
  if (init.headers) {
    const h = new Headers(init.headers);
    h.forEach((value, key) => {
      headersObject[key] = value;
    });
  }

  let bodyBase64: string | undefined;
  if (typeof init.body === 'string') {
    bodyBase64 = Buffer.from(init.body).toString('base64');
  } else if (init.body instanceof Uint8Array) {
    bodyBase64 = Buffer.from(init.body).toString('base64');
  } else if (init.body != null) {
    throw new UnsafeExternalUrlError('نوع body غير مدعوم عبر egress-proxy — استخدم نصاً أو Uint8Array فقط');
  }

  const proxyResponse = await fetch(EGRESS_PROXY_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EGRESS_PROXY_TOKEN}` },
    body: JSON.stringify({ url: targetUrl, method: init.method || 'GET', headers: headersObject, body: bodyBase64 }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!proxyResponse.ok) {
    const errorBody = await proxyResponse.json().catch(() => ({ error: 'استجابة وكيل غير صالحة' }));
    throw new UnsafeExternalUrlError(`egress-proxy رفض الطلب: ${(errorBody as { error?: string }).error || proxyResponse.status}`);
  }

  const reply = (await proxyResponse.json()) as ProxiedResponse;
  return buildResponseFromProxyReply(reply);
}

// خطأ أمني حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 8: "SSRF قد تسرّب
// بيانات: يتم اتباع Redirect إلى Origin آخر مع إعادة استخدام نفس Headers
// وBody — بالتالي يمكن أن ينتقل اسم المستخدم وكلمة المرور في طلب Login إلى
// نطاق آخر"): الإصلاح السابق (assertSafeExternalUrl على كل قفزة) يمنع فقط
// التحويل لعنوان شبكة داخلي — لا يمنع التحويل لنطاق خارجي مختلف تماماً عن
// المنصة المعتمدة، الذي يبقى "آمناً" بمعنى IP عام لكنه ليس المزوّد الذي
// وثقنا به أصلاً. طلب login يحمل username/password في body، وlistStations/
// fetchLatestReading يحملان توكن X-Authorization — كلاهما لا يجوز أن يصلا
// نطاقاً غير الذي أُرسِل إليه الطلب الأصلي. الإصلاح: يُحفَظ origin الطلب
// الأول، وأي تحويل لاحق لعنوان بـorigin مختلف (بروتوكول أو مضيف أو منفذ)
// يُرفَض صراحةً، بدل إعادة إرسال الأسرار نفسها لوجهة غير متوقَّعة.
export async function safeFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  let currentUrl = url;
  const originalOrigin = new URL(url).origin;
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = init;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    await assertSafeExternalUrl(currentUrl);

    // EGRESS_PROXY_URL (إن مُعرَّفاً) يوجّه الطلب عبر egress-proxy المنفصل —
    // redirect يُعطَّل ضمناً هناك (server.mjs لا يتبع تحويلات؛ يُعيد استجابة
    // 3xx الخام كما هي، فتُفحَص هنا بنفس منطق التحويل أدناه تماماً كما لو
    // كانت من fetch مباشر). بلا وكيل، السلوك يبقى كما كان تماماً.
    const response = EGRESS_PROXY_URL
      ? await fetchViaEgressProxy(currentUrl, fetchInit, timeoutMs)
      : await fetch(currentUrl, {
          ...fetchInit,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          cache: 'no-store',
        });

    // ردود 3xx تُعامَل كتحويل — نتحقق من Location صراحةً (نفس فحص SSRF
    // الكامل) قبل اتّباعه، بدل ترك fetch يتبعه تلقائياً بلا تحقق (كان هذا
    // بالضبط ثغرة TOCTOU: العنوان الأول آمن وقت الفحص، لكن التحويل يوجّه
    // فعلياً لعنوان داخلي لم يُفحَص إطلاقاً).
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new UnsafeExternalUrlError('استجابة تحويل بلا رأس Location صالح');
      }
      const redirectTarget = new URL(location, currentUrl);
      if (redirectTarget.origin !== originalOrigin) {
        throw new UnsafeExternalUrlError('رُفِض التحويل — الوجهة الجديدة نطاق مختلف عن المنصة المعتمدة، لا يجوز إعادة إرسال بيانات الاعتماد لها');
      }
      currentUrl = redirectTarget.toString();
      continue;
    }

    return response;
  }

  throw new UnsafeExternalUrlError('عدد التحويلات تجاوز الحد المسموح');
}
