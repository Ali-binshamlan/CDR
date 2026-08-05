-- =====================================================================
-- DCR — 202608040003_forecast_snapshots.sql
-- =====================================================================
-- القسم 9 من "دليل الإصلاح الجذري لمنظومة مرقاب" — "فصل Live عن Planning":
-- القرار الحي (evaluateLiveOperationalDecision، صفر fetch) لا يجوز أن
-- ينتظر Open-Meteo أو يعتمد على نتيجته بأي شكل. شبكة توقعات ساعات الدوام
-- (hourlyForecasts، تجيب على "هل أقدر أشتغل الساعة الفلانية؟") تبقى مفيدة
-- للواجهة/التخطيط لكنها الآن تُملأ من لقطة مخزَّنة مسبقاً (forecast_snapshots)
-- بدل استدعاء الشبكة داخل نفس دورة تقييم القرار الحي.
--
-- forecast_snapshots: جدول تخزين مؤقت (Cache) قابل لإعادة الحساب بالكامل من
-- Open-Meteo في أي وقت — ليس دليلاً تاريخياً (لا Append-only، upsert طبيعي).
-- يُحدَّثه مسار "إثراء" منفصل (Forecast Worker) لا علاقة له بمسار القرار
-- الحي إطلاقاً؛ فشله أو تأخره لا يؤثر على أي قرار مُخزَّن في final_decisions.
-- =====================================================================

create table if not exists public.forecast_snapshots (
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_group_id text not null,
  hourly jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default clock_timestamp(),
  -- أفق التوقّع (يوم النشاط) الذي بُنيت له هذه اللقطة — يسمح لمسار الإثراء
  -- بمعرفة هل اللقطة ما زالت تخص يوم النشاط الصحيح قبل إعادة استخدامها.
  activity_start_iso timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (project_id, activity_group_id)
);

create index if not exists idx_forecast_snapshots_updated_at
  on public.forecast_snapshots (updated_at);

-- لا Append-only هنا عمداً (كاش قابل لإعادة الحساب بالكامل، لا دليل) —
-- لكن يبقى مقصوراً على service_role فقط، بلا وصول مباشر من anon/authenticated.
revoke all on public.forecast_snapshots from anon, authenticated;
grant select, insert, update, delete on public.forecast_snapshots to service_role;

alter table public.forecast_snapshots enable row level security;
