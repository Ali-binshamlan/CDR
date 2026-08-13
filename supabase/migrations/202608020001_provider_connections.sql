-- =====================================================================
-- DCR — 202608020001_provider_connections.sql
-- =====================================================================
-- ربط محطة رصد (project_devices) بمصدر بيانات خارجي (شركة/Connector) يُسحب
-- منه دورياً (pull) بدل أن يدفع الجهاز بياناته (push عبر /api/devices/ingest).
-- جدول منفصل تماماً عن project_devices عمداً — project_devices يبقى تمثيلاً
-- محايداً لـ"محطة" بصرف النظر عن آلية وصول قراءاتها؛ لا نكرر هنا خطأ سابق
-- (إضافة أعمدة خاصة بشركة واحدة داخل project_devices نفسه).
-- =====================================================================

create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.project_devices(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  -- معرّف الشركة/الـConnector — نص حر لا enum/CHECK صارم عمداً: إضافة شركة
  -- جديدة يجب ألا تحتاج migration جديد لتوسيع قائمة قيم مسموحة. التحقق
  -- الفعلي من "هل هذا provider مسجَّل فعلاً؟" يتم في طبقة التطبيق (registry
  -- في app/lib/providers/registry.ts) وقت الإنشاء، لا في القاعدة.
  provider text not null,

  -- بيانات الاتصال الخاصة بهذه الشركة تحديداً (base_url/api_key/access_token/
  -- أي حقل آخر) — JSONB مرن لأن كل شركة تحتاج حقولاً مختلفة تماماً؛ أعمدة
  -- ثابتة كانت ستحتاج migration جديد لكل شركة جديدة بحقول مختلفة.
  -- ملاحظة أمنية متعمَّدة: بلا تشفير إضافي — هذه مفاتيح قراءة فقط (read-only)
  -- لأطراف ثالثة، لا SUPABASE_SERVICE_ROLE_KEY؛ تُحمى فقط بنفس مستوى
  -- service_role الذي يتجاوز RLS دائماً (لا وصول من anon/authenticated لهذا
  -- الجدول إطلاقاً، راجع RLS أدناه). يجب عدم عرض هذا العمود أبداً في أي
  -- استجابة API تصل للواجهة.
  credentials jsonb not null default '{}'::jsonb,

  -- معرّف المحطة عند الشركة (بعد اختيار المستخدم من نتيجة listStations) —
  -- null حتى يُختار فعلياً (الربط بمرحلتين: أولاً اختبار الاتصال، ثم اختيار
  -- المحطة من القائمة المجلوبة).
  vendor_station_id text,
  vendor_station_name text,

  is_active boolean not null default true,

  -- حالة آخر محاولة سحب — إشارة تشغيلية للواجهة (المستخدم لا يتحكم بالمحطة
  -- الفعلية عند الشركة، يحتاج يعرف "لماذا توقفت" بلا طلب دعم).
  last_pull_at timestamptz,
  last_pull_success boolean,
  last_pull_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- محطة واحدة (device_id) لا يجوز أن تُربط بنفس الشركة مرتين — يمنع ربطاً
  -- مكرراً عرضياً ينتج سحبين مستقلين لنفس المحطة بنفس المصدر.
  constraint provider_connections_device_provider_unique unique (device_id, provider)
);

create index idx_provider_connections_project on public.provider_connections (project_id);
create index idx_provider_connections_active on public.provider_connections (is_active) where is_active = true;

alter table public.provider_connections enable row level security;
-- بلا أي policy — نفس فلسفة project_devices: service_role (supabaseAdmin)
-- يتجاوز RLS دائماً، وكل الوصول يمر حصراً عبر API routes التي تتحقق من
-- verifyProjectOwnership يدوياً. RLS مفعّل فقط كحاجز دفاعي إضافي لو استُخدم
-- عميل anon/authenticated بالخطأ مستقبلاً (لن يرى أي صف).
revoke all on public.provider_connections from anon, authenticated;
