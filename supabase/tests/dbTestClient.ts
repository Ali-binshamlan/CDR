import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Client as PgClient } from 'pg';

// عميل اختبارات DB الحقيقية — يتصل بمكدّس Supabase المحلي (supabase start،
// راجع package.json script "test:db" و.github/workflows/ci.yml) على منافذ
// CLI القياسية، لا مشروع سحابي حقيقي أبداً. القسم 16/18.5 من "دليل الإصلاح
// الجذري لمنظومة مرقاب": اختبارات RPC/تزامن/migration تحتاج PostgreSQL
// حقيقياً (قفل استشاري، معاملات، triggers فعلية) لا تُحاكى بموثوقية عبر mock.
//
// SUPABASE_TEST_URL/SUPABASE_TEST_SERVICE_ROLE_KEY يُقرآن من البيئة (يوفّرهما
// CI بعد supabase start)، مع fallback للقيم الافتراضية القياسية لـ`supabase
// start` محلياً (JWT ديمو ثابت معروف — ليس سراً حقيقياً، موثَّق علناً في
// وثائق Supabase CLI نفسها).
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:54321';
const DEFAULT_LOCAL_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export function getTestSupabaseUrl(): string {
  return process.env.SUPABASE_TEST_URL || DEFAULT_LOCAL_URL;
}

export function getTestServiceRoleKey(): string {
  return process.env.SUPABASE_TEST_SERVICE_ROLE_KEY || DEFAULT_LOCAL_SERVICE_ROLE_KEY;
}

export function getTestDbUrl(): string {
  return process.env.SUPABASE_TEST_DB_URL || DEFAULT_LOCAL_DB_URL;
}

// عميل service_role — نفس صلاحيات app/lib/supabaseAdmin.ts بالضبط (يتجاوز
// RLS)، يُستخدم لاستدعاء RPCs واختبار سلوكها الذري مباشرة.
export function createTestSupabaseAdmin(): SupabaseClient {
  return createClient(getTestSupabaseUrl(), getTestServiceRoleKey(), {
    auth: { persistSession: false },
    db: { schema: 'public' },
  });
}

// اتصال pg خام — يلزم لاختبارات تتطلب معاملات متزامنة صريحة (BEGIN/COMMIT
// يدوية عبر جلستين منفصلتين معاً) لا يوفّرها postgrest/supabase-js (كل
// استدعاء عبره معاملة مستقلة بذاتها)، مثل اختبار قفل استشاري
// (pg_advisory_xact_lock) بين عمليتين حقيقيتين متزامنتين.
export async function createTestPgClient(): Promise<PgClient> {
  const client = new PgClient({ connectionString: getTestDbUrl() });
  await client.connect();
  return client;
}

// ينظّف صفوف اختبار بادئة معرّفها بـ'test-' من الجداول الأساسية — يُستدعى
// بين الاختبارات (لا بعد كل قاعدة، القسم 16 يوصي بقاعدة فارغة أول التشغيل
// فقط عبر supabase db reset، لا تصفير كامل بين كل it()). كل اختبار DB في
// هذا المجلد يُنشئ بياناته الخاصة بمعرّفات فريدة (crypto.randomUUID())
// لتفادي التداخل بين الاختبارات المتوازية.
export async function cleanupTestProject(admin: SupabaseClient, projectId: string): Promise<void> {
  // الحذف يمر عبر cascade من projects (on delete cascade على كل الجداول
  // التابعة — راجع migrations) إلا الجداول append-only (final_decisions،
  // إلخ) التي تُمنَع من الحذف أصلاً (forbid_evidence_mutation trigger) — تلك
  // تبقى، وهذا هو السلوك الصحيح المقصود حتى في الاختبارات، لا استثناء لها.
  await admin.from('projects').delete().eq('id', projectId);
}
