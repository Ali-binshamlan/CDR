import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// طلب مستخدم صريح: حقل "مرجع أو صورة الإثبات" (true_north_evidence_url) في
// مودال توثيق الشمال الحقيقي كان نص رابط فقط بلا أي آلية رفع فعلية —
// المستخدم يحتاج رفع صورة/PDF مباشرة من جهازه، لا لصق رابط جاهز من مصدر
// خارجي. هذا المسار يستقبل الملف (multipart/form-data)، يرفعه إلى bucket
// device-evidence (migration 202608190004، خاص غير عام)، ويعيد رابطاً
// موقَّعاً صالحاً 7 أيام — يُلصَق يدوياً في true_north_evidence_url عبر
// PATCH الحالي على .../devices/[deviceId] (لا تعديل على ذلك المسار، هذا
// مسار الرفع فقط، منفصل تماماً عن حفظ التوثيق نفسه).
//
// رابط موقَّع لا عام: الـbucket خاص (public=false) — رابط دائم بلا توقيع
// لن يعمل أصلاً. 7 أيام كافية لتوثيق فوري بعد الرفع مباشرة؛ لعرض الصورة
// لاحقاً بعد انتهاء الصلاحية يلزم توليد رابط جديد (غير مطلوب في هذا
// الإصلاح — الحقل المخزَّن نص رابط تاريخي، لا صورة معروضة حية في الواجهة
// حالياً).
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

async function loadOwnedDevice(projectId: string, deviceId: string) {
  const { data } = await supabaseAdmin
    .from('project_devices')
    .select('id, project_id')
    .eq('id', deviceId)
    .maybeSingle();
  if (!data || data.project_id !== projectId) return null;
  return data;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; deviceId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { projectId, deviceId } = await params;
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const device = await loadOwnedDevice(projectId, deviceId);
  if (!device) return NextResponse.json({ error: 'الجهاز غير موجود' }, { status: 404 });

  const formData = await request.formData().catch(() => null);
  const file = formData?.get('file');
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'لم يُرفَع أي ملف' }, { status: 400 });
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json({ error: 'نوع الملف غير مدعوم — يُقبل فقط PNG/JPEG/WEBP/PDF' }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: 'حجم الملف يتجاوز 5 ميجابايت' }, { status: 400 });
  }

  const extension = EXTENSION_BY_MIME[file.type];
  const objectPath = `${projectId}/${deviceId}/${randomUUID()}.${extension}`;

  const arrayBuffer = await file.arrayBuffer();
  const { error: uploadError } = await supabaseAdmin.storage
    .from('device-evidence')
    .upload(objectPath, arrayBuffer, { contentType: file.type, upsert: false });
  if (uploadError) {
    return NextResponse.json({ error: safeErrorResponse(uploadError, 'evidence-upload: فشل رفع الملف') }, { status: 500 });
  }

  const { data: signedData, error: signError } = await supabaseAdmin.storage
    .from('device-evidence')
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
  if (signError || !signedData) {
    return NextResponse.json({ error: safeErrorResponse(signError, 'evidence-upload: فشل توليد رابط موقَّع') }, { status: 500 });
  }

  return NextResponse.json({ url: signedData.signedUrl });
}
