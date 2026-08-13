-- =====================================================================
-- DCR — 202608130004_unused_indexes_monitoring_rpc.sql
-- =====================================================================
-- تحسين طويل المدى (طلب صريح من المستخدم: "ابغى تحسين للمدى البعيد دايماً"
-- — بعد اكتشاف idx_dust_compliance_evaluations_profile فهرس ميت تماماً في
-- الاستخدام الفعلي، idx_scan=0، أثناء التحقيق في استهلاك Disk IO Budget
-- — راجع migration 202608130001/202608130002/202608130003 لإصلاحات
-- سابقة في نفس السياق):
--
-- بدل حذف يدوي لمرة واحدة، آلية مراقبة دورية تكتشف أي فهرس ميت مستقبلاً
-- تلقائياً — لا حذف تلقائي (خطر إزالة فهرس يظهر مهماً لاحقاً تحت حمل مختلف)،
-- فقط تقرير معلوماتي يظهر في نفس endpoint المراقبة الموجود أصلاً
-- (scheduler-heartbeat) ليراه أي مراجع بشري دورياً بدل الحاجة لتشغيل SQL
-- يدوياً كل مرة.
--
-- أهم قيد تصميمي (طلب صريح من المستخدم: "اهم شي ما يسبب ضغط للداتابيس"):
-- pg_stat_user_indexes قراءة عدادات إحصائية داخلية مُخزَّنة في الذاكرة —
-- لا تُنفّذ أي seq_scan/index_scan فعلي على الجداول المفحوصة نفسها، فلا
-- تضيف أي I/O حقيقي إطلاقاً بصرف النظر عن حجم الجداول أو تكرار الاستدعاء.
-- نفس مبدأ get_database_and_table_sizes (202608110002) تماماً.
create or replace function public.list_unused_indexes()
returns table(
  table_name text,
  index_name text,
  index_bytes bigint,
  times_used bigint
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  select
    s.relname as table_name,
    s.indexrelname as index_name,
    pg_relation_size(s.indexrelid) as index_bytes,
    s.idx_scan as times_used
  from pg_stat_user_indexes s
  join pg_index i on i.indexrelid = s.indexrelid
  where s.schemaname = 'public'
    and s.idx_scan = 0
    -- استبعاد فهارس PRIMARY KEY/UNIQUE — تخدم فرض قيد سلامة البيانات حتى
    -- لو idx_scan=0 (لم تُستخدم بعد للقراءة)، لا يجوز اقتراح حذفها هنا.
    and not i.indisprimary
    and not i.indisunique
    -- فهارس أصغر من 32kB لا تستحق الإزعاج — أثرها على التخزين/الكتابة
    -- مهمل بصرف النظر عن الاستخدام.
    and pg_relation_size(s.indexrelid) > 32768
  order by pg_relation_size(s.indexrelid) desc;
$$;

revoke all on function public.list_unused_indexes() from public, anon, authenticated;
grant execute on function public.list_unused_indexes() to service_role;
