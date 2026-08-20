-- =====================================================================
-- DCR — 202608200001_alert_reads.sql
-- =====================================================================
-- طلب مستخدم صريح: "فعل خاصية مقروء/غير مقروء بالتنبيهات لكي يقل الرقم" —
-- شارة عداد التنبيهات في Sidebar.tsx تعدّ حالياً كل تنبيه غير مغلق
-- (state != CLOSED)، بلا أي علاقة بهل شافه المستخدم أم لا (راجع
-- app/api/alerts/count/route.ts). alerts.state (NEW/CLOSED) هو حالة
-- التنبيه نفسه (لا يزال قائماً أم انتهى)، عمود مُدار حصراً عبر
-- alert_state_events/الـtriggers (revoke update على authenticated، راجع
-- 202607290004_append_only_audit.sql) — إضافة قيمة ثالثة له لتمثيل
-- "مقروء" كانت ستكرر بالضبط المسار الذي أُزيل صراحةً في
-- 202608160003_drop_unused_alert_review_states.sql (REVIEWED/ACTION_TAKEN
-- غير مكتملتين، بلا أي كاتب فعلي). "مقروء" مفهوم منفصل تماماً — جدول ربط
-- جديد بمعزل كامل عن آلية state/alert_state_events، لا يمسّها إطلاقاً.
--
-- جدول ربط (لا عمود مباشر على alerts): يسمح لكل مستخدم بحالة قراءة خاصة
-- به لنفس التنبيه — ضروري لأن جهة المراقبة (account_role='viewer') ترى
-- تنبيهات عبر كل المشاريع لا تملكها (راجع alerts/count/route.ts)، فحالة
-- "قرأه المالك" و"قرأته جهة المراقبة" لنفس الصف يجب أن تبقيا مستقلتين.
create table if not exists public.alert_reads (
  alert_id uuid not null references public.alerts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (alert_id, user_id)
);

create index if not exists idx_alert_reads_user_id on public.alert_reads (user_id);

alter table public.alert_reads enable row level security;

-- كل مستخدم يقرأ/يكتب صف قراءته الخاص فقط — نفس نمط RLS البسيط المباشر
-- المستخدم في alerts_owner_select (202608130003)، لا حاجة لـsubquery على
-- المشروع هنا لأن الفحص فعلياً "هل هذا صفي أنا" فقط.
create policy "alert_reads_owner_all"
  on public.alert_reads for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- بلا هذا، اشتراك Realtime الجديد في Sidebar.tsx (قناة sidebar-alerts-
-- count، فلتر user_id=eq.<uid> على alert_reads) يفشل صامتاً بلا أي حدث
-- يصل — نفس العلة المُصلَحة سابقاً لجدول alerts نفسه في
-- 202608030004_alerts_realtime_publication.sql. idempotent بنفس النمط.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'alert_reads'
  ) then
    alter publication supabase_realtime add table public.alert_reads;
  end if;
end $$;
