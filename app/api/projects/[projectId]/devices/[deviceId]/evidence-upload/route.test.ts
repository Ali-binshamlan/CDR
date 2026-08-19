import { describe, it, expect, vi, beforeEach } from 'vitest';

// اختبارات قبول صريحة (طلب المستخدم — رفع فعلي لملف إثبات توثيق الشمال
// الحقيقي بدل حقل رابط نصي بلا آلية توفّره). يغطي: التحقق من ملكية
// المشروع/الجهاز، رفض أنواع/أحجام ملفات غير مسموحة، ورفع ناجح ينتج رابطاً
// موقَّعاً فعلياً — بمعزل عن أي اتصال Supabase Storage حقيقي (mock كامل).

let mockDeviceRow: { id: string; project_id: string } | null = { id: 'device-1', project_id: 'project-1' };
let mockUploadError: { message: string } | null = null;
let mockSignError: { message: string } | null = null;
let lastUploadCall: { path: string; contentType?: string } | null = null;

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mockDeviceRow, error: null }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        upload: async (path: string, _body: unknown, options: { contentType?: string }) => {
          lastUploadCall = { path, contentType: options?.contentType };
          return { data: mockUploadError ? null : { path }, error: mockUploadError };
        },
        createSignedUrl: async () => ({
          data: mockSignError ? null : { signedUrl: 'https://example.test/signed/device-evidence/x.png?token=abc' },
          error: mockSignError,
        }),
      }),
    },
  },
}));

let mockRequireUserIdResult: { userId: string } | { error: Response } = { userId: 'user-1' };
let mockOwnershipResult = true;

vi.mock('@/app/lib/apiAuth', () => ({
  requireUserId: async () => mockRequireUserIdResult,
  verifyProjectOwnership: async () => mockOwnershipResult,
}));

import { POST } from './route';

function makeRequest(file: File | null): Request {
  const formData = new FormData();
  if (file) formData.append('file', file);
  return new Request('http://localhost/api/projects/project-1/devices/device-1/evidence-upload', {
    method: 'POST',
    body: formData,
  });
}

const params = Promise.resolve({ projectId: 'project-1', deviceId: 'device-1' });

beforeEach(() => {
  mockDeviceRow = { id: 'device-1', project_id: 'project-1' };
  mockUploadError = null;
  mockSignError = null;
  lastUploadCall = null;
  mockRequireUserIdResult = { userId: 'user-1' };
  mockOwnershipResult = true;
});

describe('POST .../devices/[deviceId]/evidence-upload', () => {
  it('لا جلسة مصادقة → 401، بلا أي محاولة رفع', async () => {
    mockRequireUserIdResult = { error: new Response(JSON.stringify({ error: 'غير مصرّح' }), { status: 401 }) };
    const res = await POST(makeRequest(new File(['x'], 'a.png', { type: 'image/png' })) as never, { params });
    expect(res.status).toBe(401);
    expect(lastUploadCall).toBeNull();
  });

  it('المستخدم لا يملك المشروع → 403', async () => {
    mockOwnershipResult = false;
    const res = await POST(makeRequest(new File(['x'], 'a.png', { type: 'image/png' })) as never, { params });
    expect(res.status).toBe(403);
  });

  it('الجهاز لا ينتمي لهذا المشروع (أو غير موجود) → 404', async () => {
    mockDeviceRow = { id: 'device-1', project_id: 'project-OTHER' };
    const res = await POST(makeRequest(new File(['x'], 'a.png', { type: 'image/png' })) as never, { params });
    expect(res.status).toBe(404);
  });

  it('بلا ملف مرفَق إطلاقاً → 400', async () => {
    const res = await POST(makeRequest(null) as never, { params });
    expect(res.status).toBe(400);
  });

  it('نوع ملف غير مدعوم (مثال: video/mp4) → 400، لا يصل لمحاولة الرفع', async () => {
    const res = await POST(makeRequest(new File(['x'], 'a.mp4', { type: 'video/mp4' })) as never, { params });
    expect(res.status).toBe(400);
    expect(lastUploadCall).toBeNull();
  });

  it('حجم يتجاوز 5 ميجابايت → 400، لا يصل لمحاولة الرفع', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const res = await POST(makeRequest(new File([big], 'a.png', { type: 'image/png' })) as never, { params });
    expect(res.status).toBe(400);
    expect(lastUploadCall).toBeNull();
  });

  it('ملف صالح (PDF ضمن الحد) → 200، يعيد رابطاً موقَّعاً، المسار المُخزَّن يبدأ بـprojectId/deviceId', async () => {
    const res = await POST(makeRequest(new File(['%PDF-1.4'], 'cert.pdf', { type: 'application/pdf' })) as never, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://example.test/signed/device-evidence/x.png?token=abc');
    expect(lastUploadCall?.path.startsWith('project-1/device-1/')).toBe(true);
    expect(lastUploadCall?.path.endsWith('.pdf')).toBe(true);
    expect(lastUploadCall?.contentType).toBe('application/pdf');
  });

  it('فشل الرفع الفعلي في Supabase Storage → 500، رسالة آمنة بلا تفاصيل داخلية', async () => {
    mockUploadError = { message: 'permission denied for bucket device-evidence' };
    const res = await POST(makeRequest(new File(['x'], 'a.png', { type: 'image/png' })) as never, { params });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain('permission denied');
    expect(body.error).not.toContain('device-evidence');
  });

  it('فشل توليد الرابط الموقَّع بعد نجاح الرفع → 500', async () => {
    mockSignError = { message: 'signing failed' };
    const res = await POST(makeRequest(new File(['x'], 'a.png', { type: 'image/png' })) as never, { params });
    expect(res.status).toBe(500);
  });
});
