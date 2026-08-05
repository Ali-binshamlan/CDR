import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertSafeExternalUrl, UnsafeExternalUrlError } from './safeUrl';

describe('assertSafeExternalUrl', () => {
  it('يرفض بروتوكولاً غير https (القسم 15.1 — https فقط بعد الإصلاح)', async () => {
    await expect(assertSafeExternalUrl('ftp://example.com')).rejects.toThrow(UnsafeExternalUrlError);
    await expect(assertSafeExternalUrl('http://example.com')).rejects.toThrow(UnsafeExternalUrlError);
  });

  it('يرفض رابطاً غير صالح الشكل', async () => {
    await expect(assertSafeExternalUrl('not a url')).rejects.toThrow(UnsafeExternalUrlError);
  });

  it('يرفض اسم مستخدم/كلمة مرور داخل الرابط نفسه', async () => {
    await expect(assertSafeExternalUrl('https://user:pass@example.com')).rejects.toThrow(UnsafeExternalUrlError);
  });

  it('يرفض منفذاً غير 443', async () => {
    await expect(assertSafeExternalUrl('https://example.com:8443')).rejects.toThrow(UnsafeExternalUrlError);
  });

  it('يرفض localhost بأشكاله', async () => {
    await expect(assertSafeExternalUrl('https://localhost:8080')).rejects.toThrow(UnsafeExternalUrlError);
    await expect(assertSafeExternalUrl('https://LOCALHOST')).rejects.toThrow(UnsafeExternalUrlError);
    await expect(assertSafeExternalUrl('https://foo.localhost')).rejects.toThrow(UnsafeExternalUrlError);
  });

  it('يرفض IPv4 loopback', async () => {
    await expect(assertSafeExternalUrl('https://127.0.0.1')).rejects.toThrow(UnsafeExternalUrlError);
  });

  it('يرفض عنوان link-local (خدمة meta-data السحابية)', async () => {
    await expect(assertSafeExternalUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      UnsafeExternalUrlError
    );
  });

  it('يرفض نطاقات خاصة IPv4 (10.x, 172.16-31.x, 192.168.x, CGNAT 100.64.x)', async () => {
    await expect(assertSafeExternalUrl('https://10.0.0.5')).rejects.toThrow(UnsafeExternalUrlError);
    await expect(assertSafeExternalUrl('https://172.16.0.1')).rejects.toThrow(UnsafeExternalUrlError);
    await expect(assertSafeExternalUrl('https://172.31.255.255')).rejects.toThrow(UnsafeExternalUrlError);
    await expect(assertSafeExternalUrl('https://192.168.1.1')).rejects.toThrow(UnsafeExternalUrlError);
    await expect(assertSafeExternalUrl('https://100.64.0.1')).rejects.toThrow(UnsafeExternalUrlError);
  });

  it('لا يرفض عنوان 172.x خارج نطاق 172.16-31 (مثال: 172.32.x عام)', async () => {
    await expect(assertSafeExternalUrl('https://172.32.0.1')).resolves.toBeUndefined();
  });

  it('يرفض IPv6 loopback ولinkـ-local', async () => {
    await expect(assertSafeExternalUrl('https://[::1]')).rejects.toThrow(UnsafeExternalUrlError);
    await expect(assertSafeExternalUrl('https://[fe80::1]')).rejects.toThrow(UnsafeExternalUrlError);
  });

  it('يرفض IPv4 مضمَّن داخل IPv6 (::ffff:) إن كان خاصاً', async () => {
    await expect(assertSafeExternalUrl('https://[::ffff:127.0.0.1]')).rejects.toThrow(UnsafeExternalUrlError);
  });

  it('يقبل IP عام صالح مباشرة بلا استعلام DNS', async () => {
    await expect(assertSafeExternalUrl('https://8.8.8.8')).resolves.toBeUndefined();
  });
});

// القسم 18.7 من "دليل الإصلاح الجذري لمنظومة مرقاب" — DNS Rebinding: اسم
// نطاق يعيد عنواناً عاماً (A) وعنواناً خاصاً (AAAA) معاً في نفس الاستعلام.
// addresses.some(isPrivateOrReservedIP) في assertSafeExternalUrl يفحص *كل*
// عنوان مُعاد بصرف النظر عن ترتيبه — عنوان خاص واحد ضمن النتيجة يكفي للرفض،
// حتى لو جاء عنوان عام آخر معه في نفس الاستجابة.
describe('assertSafeExternalUrl — DNS Rebinding (القسم 18.7)', () => {
  afterEach(() => {
    vi.doUnmock('node:dns/promises');
    vi.resetModules();
  });

  it('اسم نطاق يعيد A عاماً وAAAA خاصاً معاً → يُرفَض (العنوان الخاص يكفي وحده)', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [
        { address: '8.8.8.8', family: 4 },
        { address: 'fe80::1', family: 6 },
      ]),
    }));
    const { assertSafeExternalUrl: assertWithMockedDns, UnsafeExternalUrlError: MockedError } = await import('./safeUrl');
    await expect(assertWithMockedDns('https://rebinding.example.test')).rejects.toThrow(MockedError);
  });

  it('اسم نطاق يعيد عنوانين عامَّين فقط → يُقبَل', async () => {
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn(async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '1.1.1.1', family: 4 },
      ]),
    }));
    const { assertSafeExternalUrl: assertWithMockedDns } = await import('./safeUrl');
    await expect(assertWithMockedDns('https://public.example.test')).resolves.toBeUndefined();
  });
});

// القسم 18.7 — Redirect إلى metadata السحابية أو أي وجهة غير معتمدة يُرفَض،
// وResponse/Timeout أكبر من الحد يُرفَضان أيضاً. يختبر safeFetch نفسه (لا
// assertSafeExternalUrl وحدها) — الحماية الحقيقية من TOCTOU تعتمد على أن كل
// قفزة تحويل تُفحَص فعلياً، لا فقط الرابط الأول.
describe('safeFetch — Redirect/Timeout/Response Size (القسم 18.7)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it('تحويل (redirect) إلى 169.254.169.254 (metadata السحابية) → يُرفَض بلا اتّباعه', async () => {
    const { safeFetch, UnsafeExternalUrlError: LocalError } = await import('./safeUrl');
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://169.254.169.254/latest/meta-data/' : null) },
    } as unknown as Response);

    await expect(safeFetch('https://8.8.8.8/redirect-me')).rejects.toThrow(LocalError);
    // fetch يُستدعى مرة واحدة فقط (الطلب الأول) — لا يتبع التحويل إطلاقاً
    // لأن assertSafeExternalUrl يرفض الوجهة الجديدة قبل أي استدعاء fetch ثانٍ.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('عدد تحويلات يتجاوز الحد المسموح (5) → يُرفَض', async () => {
    const { safeFetch, UnsafeExternalUrlError: LocalError } = await import('./safeUrl');
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      status: 302,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://8.8.8.8/next' : null) },
    } as unknown as Response);

    await expect(safeFetch('https://8.8.8.8/start')).rejects.toThrow(LocalError);
  });

  it('استجابة تحويل بلا رأس Location → تُرفَض صراحة', async () => {
    const { safeFetch, UnsafeExternalUrlError: LocalError } = await import('./safeUrl');
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: { get: () => null },
    } as unknown as Response);

    await expect(safeFetch('https://8.8.8.8/redirect-me')).rejects.toThrow(LocalError);
  });

  it('يمرر timeoutMs إلى AbortSignal.timeout — طلب بطيء يُلغى', async () => {
    const { safeFetch } = await import('./safeUrl');
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      // يحاكي fetch حقيقياً يحترم AbortSignal — يرمي فوراً لو الإشارة أُلغيت.
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    });

    await expect(safeFetch('https://8.8.8.8/slow', { timeoutMs: 1 })).rejects.toThrow();
  });

  // خطأ أمني حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 8: "SSRF قد
  // تسرّب بيانات: يتم اتباع Redirect إلى Origin آخر مع إعادة استخدام نفس
  // Headers وBody — بالتالي يمكن أن ينتقل اسم المستخدم وكلمة المرور في طلب
  // Login إلى نطاق آخر"): assertSafeExternalUrl وحده يمنع فقط عناوين الشبكة
  // الداخلية — لا يمنع تحويلاً لعنوان IP/نطاق عام لكنه مختلف تماماً عن
  // المنصة المعتمدة، الذي كان يمرّر headers/body الأصليين (توكن/كلمة مرور)
  // للوجهة الجديدة بلا أي تمييز.
  it('تحويل إلى origin مختلف تماماً (عام، لا شبكة داخلية) → يُرفَض، لا تُعاد الأسرار', async () => {
    const { safeFetch, UnsafeExternalUrlError: LocalError } = await import('./safeUrl');
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://1.1.1.1/steal-credentials' : null) },
    } as unknown as Response);

    await expect(
      safeFetch('https://8.8.8.8/api/auth/login', {
        method: 'POST',
        headers: { 'X-Authorization': 'Bearer secret-token' },
        body: JSON.stringify({ username: 'u', password: 'p' }),
      })
    ).rejects.toThrow(LocalError);
    // لا استدعاء ثانٍ لـfetch على النطاق الجديد — الأسرار لم تُرسَل إليه إطلاقاً.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('تحويل لنفس origin بمسار مختلف → يُقبَل (لا يُعامَل كتغيير نطاق)', async () => {
    const { safeFetch } = await import('./safeUrl');
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        status: 302,
        headers: { get: (name: string) => (name.toLowerCase() === 'location' ? '/api/auth/login/v2' : null) },
      } as unknown as Response)
      .mockResolvedValueOnce({ status: 200, headers: { get: () => null } } as unknown as Response);

    const response = await safeFetch('https://8.8.8.8/api/auth/login');
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('تحويل لنفس المضيف لكن بروتوكول مختلف (http بدل https) → يُرفَض كتغيير origin', async () => {
    const { safeFetch, UnsafeExternalUrlError: LocalError } = await import('./safeUrl');
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'http://8.8.8.8/downgrade' : null) },
    } as unknown as Response);

    await expect(safeFetch('https://8.8.8.8/start')).rejects.toThrow(LocalError);
  });
});

// خطأ أمني — القسم 8 من مراجعة الخبير الخارجي: "استخدام Egress Proxy/Resolver
// موثوق". EGRESS_PROXY_URL/EGRESS_PROXY_TOKEN حالة مستوى الوحدة (proxyAgent
// يُبنى مرة واحدة عند التحميل) — vi.resetModules() + استيراد ديناميكي بعد
// ضبط process.env هو الطريقة الوحيدة لاختبار كلا الفرعين (بلا وكيل، مع وكيل)
// من نفس ملف الاختبار.
// خطأ مكتشَف ومُصلَح (تجربة نشر فعلية على Fly.io): النسخة الأولى استخدمت
// undici ProxyAgent (بروتوكول HTTP CONNECT) — Fly.io لا يُمرِّر طلبات
// CONNECT للتطبيق المستضاف إطلاقاً (تُرفَض بـ502 على مستوى المنصة نفسها).
// البديل: POST عادي بصيغة JSON ({url, method, headers, body}) إلى
// egress-proxy — يعمل مع أي منصة استضافة تدعم استقبال HTTP قياسي.
describe('safeFetch — توجيه عبر Egress Proxy عند تفعيله (القسم 8)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('EGRESS_PROXY_URL غير مُعرَّف → يستخدم fetch العام مباشرة (السلوك الافتراضي بلا تغيير)', async () => {
    delete process.env.EGRESS_PROXY_URL;
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, headers: { get: () => null } } as unknown as Response));

    const { safeFetch } = await import('./safeUrl');
    await safeFetch('https://8.8.8.8/no-proxy');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('EGRESS_PROXY_URL مُعرَّف → يرسل POST بصيغة JSON للوكيل مع Authorization، لا fetch مباشر للهدف', async () => {
    process.env.EGRESS_PROXY_URL = 'https://dcr-egress-proxy.fly.dev/fetch';
    process.env.EGRESS_PROXY_TOKEN = 'proxy-secret-token';
    vi.resetModules();

    const proxyReplyBody = { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}').toString('base64') };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => proxyReplyBody,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const { safeFetch } = await import('./safeUrl');
    const response = await safeFetch('https://8.8.8.8/via-proxy', {
      method: 'POST',
      headers: { 'X-Authorization': 'Bearer target-token' },
      body: 'hello',
    });

    expect(response.status).toBe(200);
    // استدعاء واحد فقط — للوكيل نفسه، لا للهدف الأصلي مباشرة.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [proxyUrl, proxyInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(proxyUrl).toBe('https://dcr-egress-proxy.fly.dev/fetch');
    expect((proxyInit.headers as Record<string, string>).Authorization).toBe('Bearer proxy-secret-token');

    const sentPayload = JSON.parse(proxyInit.body as string);
    expect(sentPayload.url).toBe('https://8.8.8.8/via-proxy');
    expect(sentPayload.method).toBe('POST');
    expect(sentPayload.headers['x-authorization']).toBe('Bearer target-token');
    expect(Buffer.from(sentPayload.body, 'base64').toString('utf8')).toBe('hello');

    vi.unstubAllGlobals();
  });

  it('الوكيل يرد بخطأ (ok=false) → يُرمى UnsafeExternalUrlError برسالة الوكيل', async () => {
    process.env.EGRESS_PROXY_URL = 'https://dcr-egress-proxy.fly.dev/fetch';
    process.env.EGRESS_PROXY_TOKEN = 'proxy-secret-token';
    vi.resetModules();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: 'عنوان شبكة داخلي غير مسموح' }),
      } as unknown as Response)
    );

    const { safeFetch, UnsafeExternalUrlError: LocalError } = await import('./safeUrl');
    await expect(safeFetch('https://8.8.8.8/blocked')).rejects.toThrow(LocalError);

    vi.unstubAllGlobals();
  });
});
