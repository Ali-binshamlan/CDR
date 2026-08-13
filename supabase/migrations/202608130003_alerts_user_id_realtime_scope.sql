-- =====================================================================
-- DCR — 202608130003_alerts_user_id_realtime_scope.sql
-- =====================================================================
-- حل جذري وطويل المدى (طلب صريح من المستخدم: "ابغى خيار على المدى
-- البعيد") لمشكلة استهلاك Disk IO Budget عبر Supabase Realtime — راجع
-- migration 202608130001/202608130002 لإصلاحات مماثلة على cron jobs.
--
-- قياس فعلي عبر pg_stat_statements (2026-08-13) كشف أن realtime.list_
-- changes وحدها تستهلك ~131 مليون كتلة I/O — أكثر من 100 ضعف أي استعلام
-- آخر في كامل قاعدة البيانات، رغم 1-5 مستخدمين متزامنين فقط. السبب
-- الجذري: app/components/dashborad/Sidebar.tsx (مشترَك في كل صفحة من لوحة
-- التحكم، اشتراك دائم مفتوح طوال الجلسة) كان يشترك بـevent:'*' بلا أي
-- filter على جدول alerts بأكمله، وRLS الحالية (alerts_owner_select،
-- 202608020003) تحتوي subquery على projects لكل صف — يُعاد تقييمها لكل
-- حدث WAL على الجدول من قِبل كل جلسة مشترِكة، بصرف النظر عن ملاءمة الصف
-- لتلك الجلسة تحديداً.
--
-- الإصلاح الجذري: عمود alerts.user_id مباشر (denormalized من
-- projects.user_id وقت إنشاء التنبيه) يسمح لـpostgres_changes بفلترة
-- الاشتراك نفسه (filter: user_id=eq.<uid>) بدل الاشتراك بالجدول بأكمله —
-- كل جلسة تستقبل فقط الأحداث الخاصة بمستخدمها من الأساس (على مستوى بروتوكول
-- Realtime، قبل حتى وصول الحدث لتقييم RLS الكامل)، بلا أي تأخير أو تنازل عن
-- الفورية. RLS نفسها تُبسَّط لمقارنة عمود مباشر (user_id = auth.uid()) بدل
-- subquery — أخف أيضاً على كل مسار قراءة عادي لجدول alerts، لا فقط Realtime.
--
-- trigger (لا تعديل على create_alert_atomic أو أي دالة أخرى تُدرج صفوفاً)
-- يملأ user_id تلقائياً من projects.user_id عند كل INSERT — يعمل بصرف
-- النظر عن أي مسار إدراج مستقبلي، بلا حاجة لتذكّر تمرير user_id يدوياً في
-- كل استدعاء.

alter table public.alerts add column if not exists user_id uuid references auth.users(id) on delete cascade;

create or replace function public.set_alert_user_id_from_project()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if NEW.user_id is null then
    select user_id into NEW.user_id from public.projects where id = NEW.project_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_set_alert_user_id on public.alerts;
create trigger trg_set_alert_user_id
  before insert on public.alerts
  for each row
  execute function public.set_alert_user_id_from_project();

-- تعبئة الصفوف الموجودة مسبقاً (backfill) — بلا هذا، تنبيهات قديمة تبقى
-- user_id=null فلا تُبَث أبداً عبر الفلتر الجديد لصاحبها الفعلي.
update public.alerts a
set user_id = p.user_id
from public.projects p
where a.project_id = p.id and a.user_id is null;

create index if not exists idx_alerts_user_id on public.alerts (user_id);

-- RLS مُبسَّطة: مقارنة عمود مباشر بدل EXISTS+subquery على projects — أخف
-- تقييماً لكل قراءة عادية أيضاً، لا فقط لمسار Realtime.
drop policy if exists "alerts_owner_select" on public.alerts;
create policy "alerts_owner_select"
  on public.alerts for select
  to authenticated
  using (user_id = auth.uid());
