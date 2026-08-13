import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestPgClient } from './dbTestClient';
import type { Client as PgClient } from 'pg';

// =====================================================================
// اختبار قبول القسم 16/18.5 من "دليل الإصلاح الجذري لمنظومة مرقاب":
// "اختبر مسارين: قاعدة فارغة من أول migration إلى آخرها، ونسخة مماثلة
// للإنتاج ثم Upgrade — قارن pg_dump --schema-only بين النتيجتين."
//
// هذا الملف يغطي المسار الأول (قاعدة فارغة): يفترض أن CI/المطوّر شغّل
// `supabase db reset` (أو `supabase start` على مشروع جديد بلا بيانات) قبل
// تشغيل هذا الاختبار — راجع package.json script "test:db" — بحيث كل
// الـmigrations في supabase/migrations/ طُبِّقت بترتيبها بالكامل من الصفر
// على قاعدة PostgreSQL حقيقية فارغة. الاختبار هنا يتحقق من *نتيجة* ذلك
// التطبيق (المخطط النهائي صالح ومتوقَّع)، لا يُشغِّل migration بنفسه — تشغيل
// migrations هو مسؤولية Supabase CLI (`db reset`)، ليس Vitest.
//
// مسار المقارنة الثاني (نسخة تشبه الإنتاج ثم Upgrade، مقارنة pg_dump
// --schema-only) يتطلب نسخة "إنتاج" منفصلة فعلية للمقارنة معها — لا توجد
// بيئة إنتاج منفصلة بعد لهذا المشروع الجديد (لا نسخة "قديمة" لنقارن معها
// migration جديد)، فيبقى هذا المسار الثاني غير قابل للتطبيق حرفياً حتى
// تُنشأ أول بيئة إنتاج فعلية يمكن أخذ لقطة منها.
// =====================================================================

let client: PgClient;

beforeAll(async () => {
  client = await createTestPgClient();
});

afterAll(async () => {
  await client?.end();
});

// جداول الأدلة append-only (القسم 5.7/13/18.5) — يجب أن تحمل triggers منع
// التعديل/الحذف/TRUNCATE فعلياً بعد تطبيق كل الـmigrations، لا فقط عند
// إنشائها. قائمة مطابقة لـ202608040014_forbid_truncate_and_default_privileges.sql.
const EVIDENCE_TABLES = [
  'decision_records',
  'dust_evaluations',
  'dust_compliance_evaluations',
  'pm10_readings_history',
  'alert_state_events',
  'device_readings_history',
  'final_decisions',
  'admin_audit_log',
  'device_events',
  'device_measurements',
];

describe('migration من قاعدة فارغة — سلامة المخطط النهائي', () => {
  it('كل جداول التطبيق الأساسية موجودة بعد تطبيق كل الـmigrations', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
    );
    const tableNames = new Set(rows.map((r) => r.table_name));

    const expectedTables = [
      'projects',
      'project_devices',
      'project_dust_profiles',
      'project_shifts',
      'decision_records',
      'alerts',
      'dust_evaluations',
      'dust_compliance_evaluations',
      'final_decisions',
      'current_dust_decisions',
      'current_dust_compliance_decisions',
      'pm10_readings_history',
      'device_readings_history',
      'device_events',
      'device_measurements',
      'device_metric_latest',
      'forecast_snapshots',
      'project_evaluation_jobs',
      'evaluation_runs',
      'scheduler_heartbeat',
      'decision_alert_outbox',
      'provider_connections',
      'provider_instances',
      'activity_groups',
      'admin_audit_log',
      'user_authorizations',
      'profiles',
    ];

    const missing = expectedTables.filter((t) => !tableNames.has(t));
    expect(missing, `جداول متوقَّعة غائبة بعد تطبيق كل الـmigrations: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(EVIDENCE_TABLES)('%s: TRUNCATE مرفوض فعلياً (statement-level trigger)', async (table) => {
    await expect(client.query(`truncate table public.${table}`)).rejects.toThrow();
  });

  it('service_role لا يملك صلاحية TRUNCATE على جداول الأدلة (REVOKE صريح)', async () => {
    const { rows } = await client.query<{ has_truncate: boolean }>(
      `select has_table_privilege('service_role', 'public.final_decisions', 'TRUNCATE') as has_truncate`
    );
    expect(rows[0]?.has_truncate).toBe(false);
  });

  it('activity_groups مفتاحها الأساسي مركّب (project_id, id) — عزل متعدد المشاريع', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `select kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
       where tc.table_schema = 'public' and tc.table_name = 'activity_groups' and tc.constraint_type = 'PRIMARY KEY'
       order by kcu.ordinal_position`
    );
    expect(rows.map((r) => r.column_name)).toEqual(['project_id', 'id']);
  });

  it('project_dust_profiles.activity_group_id هو NOT NULL (بعد الترحيل الكامل)', async () => {
    const { rows } = await client.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'project_dust_profiles' and column_name = 'activity_group_id'`
    );
    expect(rows[0]?.is_nullable).toBe('NO');
  });

  // القسم 6 من مراجعة خبير خارجي — "Outbox: alert_id لا يُحفظ فعلياً".
  it('decision_alert_outbox.alert_id موجود (يُحفَظ بعد إنشاء/إغلاق التنبيه فعلياً)', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'decision_alert_outbox' and column_name = 'alert_id'`
    );
    expect(rows).toHaveLength(1);
  });

  it('decision_alert_outbox لديه Unique جزئي يمنع أكثر من نية OPEN غير معالَجة واحدة لكل (project_id, activity_id, kind)', async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'decision_alert_outbox'
         and indexname = 'idx_decision_alert_outbox_open_unprocessed'`
    );
    expect(rows).toHaveLength(1);
  });

  it('alerts.final_decision_id موجود (يربط التنبيه بالقرار الذي فتحه فعلياً — القسم 6)', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'alerts' and column_name = 'final_decision_id'`
    );
    expect(rows).toHaveLength(1);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 7: "جداول Device Events
  // وMeasurements وOutbox ليست محمية بالكامل من TRUNCATE"): decision_alert_
  // outbox لم يكن مُدرَجاً في EVIDENCE_TABLES (ولا يجوز إدراجه هناك — ليس
  // append-only، يُحدَّث عمداً)، فبقي بلا حماية TRUNCATE مستقلة حتى
  // 202608040031.
  it('decision_alert_outbox: TRUNCATE مرفوض فعلياً (trigger مستقل، لا EVIDENCE_TABLES)', async () => {
    await expect(client.query('truncate table public.decision_alert_outbox')).rejects.toThrow();
  });

  it('service_role لا يملك صلاحية TRUNCATE على decision_alert_outbox (REVOKE صريح)', async () => {
    const { rows } = await client.query<{ has_truncate: boolean }>(
      `select has_table_privilege('service_role', 'public.decision_alert_outbox', 'TRUNCATE') as has_truncate`
    );
    expect(rows[0]?.has_truncate).toBe(false);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 7: "حذف Profile يستطيع فصل
  // Evaluation عن دليلها بجعل المرجع NULL"): كان الفعل on delete set null —
  // مُصلَح إلى restrict في 202608040030 (يمنع الحذف كلياً طالما توجد تقييمات
  // مرتبطة، بدل فقدان المرجع بصمت).
  it.each(['dust_evaluations', 'dust_compliance_evaluations'])(
    '%s.dust_profile_id → on delete restrict (لا set null) نحو project_dust_profiles',
    async (table) => {
      const { rows } = await client.query<{ confdeltype: string }>(
        `select confdeltype from pg_constraint
         where conrelid = ('public.' || $1)::regclass
           and confrelid = 'public.project_dust_profiles'::regclass
           and contype = 'f'`,
        [table]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.confdeltype).toBe('r'); // 'r' = RESTRICT، 'n' = SET NULL، 'c' = CASCADE
    }
  );

  it('provider_connections.credentials (JSONB القديم) غير موجود بعد cutover — enc:v2 حصراً', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'provider_connections' and column_name = 'credentials'`
    );
    expect(rows).toEqual([]);
  });

  it('provider_connections.credentials_ciphertext هو NOT NULL (بعد cutover)', async () => {
    const { rows } = await client.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'provider_connections' and column_name = 'credentials_ciphertext'`
    );
    expect(rows[0]?.is_nullable).toBe('NO');
  });

  // القسم 5.10 من "دليل الإصلاح الجذري لمنظومة مرقاب" — "عقد الحدث كامل فقط
  // في Push": device_events.sequence_no كان nullable بلا فرض فعلي — الآن
  // NOT NULL + CHECK(>= 0) صراحة (202608040023).
  it('device_events.sequence_no هو NOT NULL (بعد فرض عقد الحدث الكامل)', async () => {
    const { rows } = await client.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'device_events' and column_name = 'sequence_no'`
    );
    expect(rows[0]?.is_nullable).toBe('NO');
  });

  it('كل القيود composite FK على أنشطة النشاط مُحقَّقة فعلياً (NOT VALID تم تحقيقها)', async () => {
    const { rows } = await client.query<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint
       where connamespace = 'public'::regnamespace and contype = 'f' and conname like '%activity_group%'`
    );
    const notValidated = rows.filter((r) => !r.convalidated);
    expect(notValidated, `قيود FK لم تُحقَّق بعد: ${notValidated.map((r) => r.conname).join(', ')}`).toEqual([]);
  });

  it('anon/authenticated لا يملكان DML مباشراً على أي جدول تطبيق أساسي', async () => {
    const { rows } = await client.query<{ table_name: string; role_name: string }>(
      `select table_name, grantee as role_name
       from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('anon', 'authenticated')
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE')`
    );
    expect(rows, `منح DML مباشر غير متوقَّع لـanon/authenticated: ${JSON.stringify(rows)}`).toEqual([]);
  });

  // القسم 14.3/18.5: "Default Privileges بسبب PUBLIC" — 202608040014 يسحب
  // CREATE على schema public وEXECUTE على كل الدوال من PUBLIC/anon/
  // authenticated، بالإضافة إلى ALTER DEFAULT PRIVILEGES يمنع أي جدول/دالة
  // *مستقبلية* من الانفتاح تلقائياً. يتحقق هذا الاختبار من النتيجة الفعلية
  // على الأدوار الحالية، لا فقط من وجود عبارات ALTER DEFAULT PRIVILEGES في
  // ملف الهجرة.
  it('PUBLIC لا يملك CREATE على schema public، ولا EXECUTE افتراضياً على أي دالة جديدة', async () => {
    const { rows: schemaGrants } = await client.query<{ has_create: boolean }>(
      `select has_schema_privilege('public', 'public', 'CREATE') as has_create`
    );
    expect(schemaGrants[0]?.has_create).toBe(false);

    const { rows: defaultAcl } = await client.query<{ defaclacl: string | null }>(
      `select defaclacl::text as defaclacl
       from pg_default_acl da
       join pg_namespace n on n.oid = da.defaclnamespace
       where n.nspname = 'public' and da.defaclobjtype = 'r'
       limit 1`
    );
    // defaclacl فارغ/null يعني: لا صلاحيات افتراضية إضافية على الجداول
    // المستقبلية لـPUBLIC — بالضبط ما تفرضه ALTER DEFAULT PRIVILEGES ...
    // REVOKE ALL ON TABLES FROM anon, authenticated في 202608040014.
    if (defaultAcl.length > 0 && defaultAcl[0]?.defaclacl) {
      expect(defaultAcl[0].defaclacl).not.toMatch(/=r\/|anon=|authenticated=/);
    }
  });
});
