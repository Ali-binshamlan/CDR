import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * True North Evidence Upload Endpoint:
 * Handles multipart/form-data uploads for true north orientation verification documents 
 * (images and PDFs) associated with a specific project device.
 *
 * Operational, Security & Architectural Highlights:
 * 1. Scope & Ownership Enforcement: Validates user session (`requireUserId`), project ownership (`verifyProjectOwnership`), 
 *    and verifies device assignment to the project (`loadOwnedDevice`).
 * 2. File Validation: Restricts file types to PNG, JPEG, WEBP, and PDF, while capping uploads at 5 MB.
 * 3. Secure Storage Management: Uploads files to a private Supabase bucket (`device-evidence`) using UUID-isolated paths.
 * 4. Signed URL Access: Generates a 7-day signed URL (`createSignedUrl`) to allow secure temporary access to uploaded proof.
 */

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

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

  /*
   * Verify project ownership boundaries
   */
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  /*
   * Confirm device belongs to the authorized project scope
   */
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

  /*
   * Upload binary buffer to private device-evidence bucket
   */
  const { error: uploadError } = await supabaseAdmin.storage
    .from('device-evidence')
    .upload(objectPath, arrayBuffer, { contentType: file.type, upsert: false });

  if (uploadError) {
    return NextResponse.json(
      { error: safeErrorResponse(uploadError, 'evidence-upload: فشل رفع الملف') },
      { status: 500 }
    );
  }

  /*
   * Generate temporary signed access URL
   */
  const { data: signedData, error: signError } = await supabaseAdmin.storage
    .from('device-evidence')
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);

  if (signError || !signedData) {
    return NextResponse.json(
      { error: safeErrorResponse(signError, 'evidence-upload: فشل توليد رابط موقَّع') },
      { status: 500 }
    );
  }

  return NextResponse.json({ url: signedData.signedUrl });
}