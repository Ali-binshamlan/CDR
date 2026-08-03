-- =====================================================================
-- هجرة: قواعد استمرار PM10 الزمنية + محاذاة الشمال الحقيقي
--
-- تُطبِّق 3 قواعد كانت غائبة تماماً من محرك الامتثال لأنها تحتاج تتبّعاً
-- زمنياً/تراكمياً للقراءات (لا يمكن تقييمها من لحظة واحدة):
--   • RCRC-PM10-340-VIOLATION-011: يلزم استمرار PM10≥340 لأكثر من دقيقتين
--     متتاليتين قبل تصنيفها مخالفة تنظيمية مؤكدة (MANDATORY_STOP).
--   • MRQ-PM10-BLACK-PENDING-104: قراءة ≥340 لم تستمر بعد دقيقتين كاملتين
--     تبقى "معلَّقة" (STOP_AFFECTED_ACTIVITY، لا MANDATORY_STOP بعد).
--   • RCRC-PM10-30M-SUSPENSION-012: استمرار PM10≥250 لمدة 30 دقيقة يُفعِّل
--     تعليق النشاط (SUSPEND_ACTIVITY، درجة قرار منفصلة عن التحذير العادي).
--
-- المصدر الوحيد لقراءات مستمرة فعلياً هو أجهزة الرصد (project_devices)
-- وأي قراءة يدوية (onsite_pm10) تُدخَل عبر تقييم فعلي — كلاهما يُسجَّل هنا
-- بجدول تاريخي منفصل حتى نقدر نحسب "منذ متى استمرت هذه القراءة" بدقة، لا
-- الاعتماد على توقيت تقييمات dust_compliance_evaluations المتقطّع.
-- =====================================================================

create table if not exists public.pm10_readings_history (
  id uuid primary key default gen_random_uuid(),
  activity_group_id text not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  pm10_ug_m3 numeric not null,
  -- مصدر القراءة: 'device' (جهاز رصد فعلي عبر /api/devices/ingest) أو
  -- 'manual' (onsite_pm10 عبر تقييم فعلي لصفحة المشروع/المولّد المجدول).
  source text not null check (source in ('device', 'manual')),
  recorded_at timestamptz not null default now()
);

create index if not exists idx_pm10_readings_history_group_time
  on public.pm10_readings_history (activity_group_id, recorded_at desc);

alter table public.pm10_readings_history enable row level security;

-- true north: إضافة على مستوى المشروع — يوثّق ما إذا كانت محطة الرصد
-- معايَرة فعلياً على الشمال الحقيقي (لا شمال مغناطيسي أو تقريبي)، شرط
-- مسبق لصلاحية استخدام windDirectionDeg في أي قاعدة تعتمد على اتجاه الرياح
-- (مثل تصعيد "مستقبِل حساس باتجاه الريح"). راجع MRQ-DATA-TRUE-NORTH-111
-- وMRQ-RECEPTOR-DOWNWIND-120 في app/utils/dust-compliance-engine/rulebook.ts.
alter table public.projects
  add column if not exists true_north_alignment_documented boolean;
