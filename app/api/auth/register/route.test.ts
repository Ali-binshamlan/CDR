import { describe, it, expect, vi, beforeEach } from 'vitest';

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "محدد
// المعدل غير موزع ومسار التسجيل يحتاج إعادة ضبط") — يغطي هذا الملف:
//   (1) الحد المحلي (rateLimit.ts) والحد الموزَّع (distributedRateLimit.ts،
//       fail-open حالياً بلا Redis) معاً.
//   (2) CAPTCHA (captcha.ts، fail-open حالياً بلا TURNSTILE_SECRET_KEY).
//   (3) عزل عميل auth.signUp (createClient محلي لكل طلب) عن supabaseAdmin
//       المشترك (service_role، مقصور على create_profile_and_authorization_atomic
//       وauth.admin.deleteUser فقط).
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

let signUpResult: { data: unknown; error: { message: string } | null } = {
  data: { user: { id: 'user-1', identities: [{ id: 'ident-1' }] }, session: { access_token: 'tok' } },
  error: null,
};
const createClientCalls: Array<{ url: string; key: string }> = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string) => {
    createClientCalls.push({ url, key });
    return {
      auth: {
        signUp: async () => signUpResult,
      },
    };
  },
}));

let rpcError: { message: string; code?: string } | null = null;
let deleteUserCalls: string[] = [];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: rpcError };
    },
    auth: {
      admin: {
        deleteUser: async (userId: string) => {
          deleteUserCalls.push(userId);
          return { data: null, error: null };
        },
      },
    },
  },
}));

let distributedAllowed = true;
vi.mock('@/app/lib/distributedRateLimit', () => ({
  checkDistributedRateLimit: async () => ({ allowed: distributedAllowed, distributed: true }),
}));

let captchaOk = true;
vi.mock('@/app/lib/captcha', () => ({
  verifyTurnstileToken: async () => (captchaOk ? { ok: true, configured: true } : { ok: false, configured: true, reason: 'فشل التحقق' }),
}));

// checkRateLimit (rateLimit.ts) يحمل حالة Map على مستوى الوحدة، مشتركة عبر
// كل اختبارات هذا الملف (لا إعادة تصفير تلقائية بين it()) — IP فريد لكل
// اختبار (عداد متزايد) يمنع تسرّب حالة "استُنفد الحد" من اختبار سابق إلى
// اختبار لاحق لا علاقة له بحد المعدل إطلاقاً.
let ipCounter = 0;
function nextTestIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

function makeRequest(body: Record<string, unknown>, ip: string = nextTestIp()): Request {
  return new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

const validBody = {
  email: 'test@example.com',
  password: 'password123',
  companyName: 'Acme',
  username: 'testuser',
  phoneNumber: '0500000000',
  role: 'owner',
  captchaToken: 'valid-token',
};

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    signUpResult = {
      data: { user: { id: 'user-1', identities: [{ id: 'ident-1' }] }, session: { access_token: 'tok' } },
      error: null,
    };
    rpcError = null;
    deleteUserCalls = [];
    rpcCalls.length = 0;
    createClientCalls.length = 0;
    distributedAllowed = true;
    captchaOk = true;
  });

  it('نجاح كامل → 201، RPC ذرّية واحدة تُستدعى بـuser_id الصحيح، لا deleteUser', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('create_profile_and_authorization_atomic');
    expect(rpcCalls[0].args.p_user_id).toBe('user-1');
    expect(rpcCalls[0].args.p_username).toBe('testuser');
    expect(deleteUserCalls).toHaveLength(0);
  });

  // اختبار قبول صريح (البند 2 — "استخدم anon client معزولًا لكل طلب"):
  // createClient (لـsignUp) يُستدعى بمفتاح anon، لا service_role.
  it('auth.signUp يُستدعى عبر عميل anon معزول، لا service_role', async () => {
    const { POST } = await import('./route');
    await POST(makeRequest(validBody));

    expect(createClientCalls).toHaveLength(1);
    expect(createClientCalls[0].key).toBe('test-anon-key');
    expect(createClientCalls[0].key).not.toBe('test-service-role-key');
  });

  // اختبار قبول صريح (البند 3 — "أنشئ profile وauthorization عبر Trigger/
  // RPC ذرية"): فشل RPC → deleteUser يُستدعى (تعويض)، لا إدراجين منفصلين.
  it('فشل RPC الذرّية → يحذف مستخدم auth، يُرجع خطأً واضحاً', async () => {
    rpcError = { message: 'db error' };
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(deleteUserCalls).toEqual(['user-1']);
    expect(body.error).toBeDefined();
  });

  it('فشل RPC بتعارض اسم مستخدم مكرر (23505) → رسالة عربية مخصَّصة', async () => {
    rpcError = { message: 'duplicate key', code: '23505' };
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('مسجل مسبقاً');
    expect(deleteUserCalls).toEqual(['user-1']);
  });

  it('حقول أساسية مفقودة (بلا username) → 400 قبل أي استدعاء signUp/RPC', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ ...validBody, username: undefined }));

    expect(res.status).toBe(400);
    expect(createClientCalls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  // اختبار قبول صريح (البند 1 — "Rate limit موزع/Edge"): فشل الحد الموزَّع
  // يرفض الطلب حتى لو الحد المحلي لم يُستنفَد بعد.
  it('الحد الموزَّع (Redis) يرفض الطلب → 429، لا استدعاء signUp', async () => {
    distributedAllowed = false;
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(429);
    expect(createClientCalls).toHaveLength(0);
  });

  it('الحد المحلي (بالذاكرة) يرفض بعد تجاوز العدد المسموح ضمن النافذة → 429', async () => {
    const { POST } = await import('./route');
    const fixedIp = nextTestIp();
    for (let i = 0; i < 5; i++) {
      await POST(makeRequest({ ...validBody, email: `user${i}@example.com` }, fixedIp));
    }
    const res = await POST(makeRequest({ ...validBody, email: 'user6@example.com' }, fixedIp));
    expect(res.status).toBe(429);
  });

  // اختبار قبول صريح (البند 1 — "CAPTCHA للتسجيل العام"): فشل التحقق يمنع
  // التسجيل، قبل الوصول لـsignUp.
  it('فشل التحقق من CAPTCHA → 400، لا استدعاء signUp', async () => {
    captchaOk = false;
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('CAPTCHA');
    expect(createClientCalls).toHaveLength(0);
  });

  it('حساب يحتاج تأكيد بريد إلكتروني (session=null) → requiresConfirmation=true، 200', async () => {
    signUpResult = {
      data: { user: { id: 'user-2', identities: [{ id: 'ident-2' }] }, session: null },
      error: null,
    };
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.requiresConfirmation).toBe(true);
  });

  it('فشل signUp نفسه (بريد مستخدم مسبقاً مثلاً) → 400، لا RPC يُستدعى', async () => {
    signUpResult = { data: { user: null }, error: { message: 'email already registered' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('email already registered');
    expect(rpcCalls).toHaveLength(0);
  });
});
