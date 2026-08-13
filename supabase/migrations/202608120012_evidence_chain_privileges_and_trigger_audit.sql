-- =====================================================================
-- DCR — 202608120012_evidence_chain_privileges_and_trigger_audit.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "صلاحيات
-- وفحص سلسلة الأدلة ناقصة") — أربع مشكلات مستقلة:
--
-- (1) service_role يملك INSERT مباشراً على evidence_hash_ledger (202608110007)
--     وevidence_chain_head (202608120009) — أي كود يعمل بدور service_role
--     (كل API routes في هذا المشروع) يقدر يُدرج/يُحدِّث صفاً في الدفتر مباشرة،
--     متجاوزاً append_evidence_hash_link() بالكامل (بلا المرور عبر INSERT
--     حقيقي على جدول مصدر يُطلِق الـtrigger) — previous_hash/chain_hash
--     يُدخَلان يدوياً بلا أي علاقة حقيقية بصف مصدر فعلي، يكسر ضمان السلسلة
--     من جذوره. الإصلاح: REVOKE INSERT/UPDATE من service_role على كلا
--     الجدولين — الكتابة الوحيدة المتبقية تمر عبر append_evidence_hash_link()
--     نفسها، التي تحتاج الآن SECURITY DEFINER (البند التالي) لتستمر بالعمل
--     رغم أن الدور المُطلِق (service_role عادة) لم يعد يملك الصلاحية المباشرة.
--
-- (2) append_evidence_hash_link() كانت SECURITY INVOKER (الافتراضي بلا شرط
--     صريح) — بعد سحب INSERT/UPDATE المباشرين من service_role في (1)، ستفشل
--     كتابتها للدفتر/الصف الثابت لأن الدور المُطلِق للـtrigger (نفس الدور
--     الذي نفّذ INSERT الأصلي على الجدول المصدر) لم يعد يملك تلك الصلاحية.
--     الإصلاح: SECURITY DEFINER (تُنفَّذ بصلاحيات مالك الدالة — نفس دور
--     migrations، يملك كل الصلاحيات على كل الجداول ضمنياً) — محدود عمداً
--     (لا "محدود" بمعنى صلاحيات أضعف، بل بمعنى: الدالة نفسها لا تقبل أي
--     مدخل من المستدعي غير TG_TABLE_NAME/NEW الموفَّرين تلقائياً من محرك
--     الـtrigger نفسه — لا معامل نصي حر يمكن استغلاله لتنفيذ SQL عشوائي
--     بصلاحيات المالك؛ search_path مقيَّد صراحة بنفس القائمة الحالية، يمنع
--     schema hijacking حتى مع SECURITY DEFINER).
--
-- (3) check_evidence_trigger_integrity() (202608110010) تتوقع أسماء لا
--     تطابق الواقع فعلياً، وبعض triggers غائبة تماماً — لا مجرد تسمية:
--       - dust_compliance_evaluations: الاسم الحقيقي compliance_evaluations_
--         immutable (202607290004)، لا dust_compliance_evaluations_immutable
--         كما تتوقع الدالة — الفحص كان يُبلِغ "معطَّل" زوراً لهذا الجدول
--         دائماً (trigger موجود وفعّال فعلاً، لكن باسم مختلف عمّا تبحث عنه
--         الدالة، فتراه غائباً تماماً عبر LEFT JOIN).
--       - device_events/device_measurements: لا trigger _immutable على أي
--         منهما إطلاقاً في أي migration سابق (لهما _no_truncate و
--         _hash_chain_append فقط) — ثغرة حقيقية: UPDATE/DELETE مباشر على
--         هذين الجدولين غير ممنوع فعلياً، رغم كونهما أدلة جهاز حساسة بنفس
--         درجة device_readings_history. الإصلاح الفعلي هنا إذن مزدوج: (أ)
--         إنشاء trigger _immutable فعلي على الجدولين (لا فقط تصحيح اسم في
--         دالة الفحص لتطابق ثغرة موجودة)، (ب) تصحيح الاسم المتوقَّع لـ
--         dust_compliance_evaluations ليطابق الواقع الصحيح فعلاً.
--     كما أن evidence_chain_head (202608120009، جدول جديد يحمل نفس درجة
--     حساسية evidence_hash_ledger) لم يكن مُدرَجاً إطلاقاً في قائمة الجداول
--     المفحوصة — أُضيف الآن (immutable/no_truncate فقط، بلا hash_chain_append
--     لأنه ليس جدول مصدر أدلة، بل الصف الثابت الذي يقود السلسلة نفسها).
--
-- (4) صف genesis (202608110007) يستدعي digest()/encode() مباشرة داخل عبارة
--     INSERT...SELECT على مستوى الـmigration نفسه (لا داخل دالة تحمل
--     search_path صريحاً) — يعتمد كلياً على search_path الافتراضي لدور
--     التنفيذ وقت تطبيق تلك الهجرة تحديداً. لو لم يكن pgcrypto (يوفّر
--     digest()) ضمن ذلك الـsearch_path الافتراضي (شائع في مشاريع Supabase
--     الحديثة: pgcrypto مثبَّتة في schema منفصل اسمه extensions، لا public) —
--     الهجرة الأصلية نفسها كانت ستفشل بالخطأ الموثَّق في تعليقات 202608110008/
--     202608110011 ("42883: function digest(text, unknown) does not exist").
--     التصحيح الفعلي بأثر رجعي مستحيل هنا (تلك الهجرة طُبِّقت بالفعل أو لم
--     تُطبَّق أصلاً بنفس الصياغة على أي بيئة تعتمد عليها) — هذا القسم يوثّق
--     الصياغة الصحيحة (extensions.digest صراحة) كمرجع لأي إدراج مشابه
--     مستقبلي خارج دالة، ويتحقق دفاعياً أن صف genesis الحالي (إن وُجد) يحمل
--     قيمة hash صحيحة فعلاً بمقارنته بإعادة حساب صريحة الآن.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (3أ) trigger _immutable مفقود فعلياً على device_events/device_measurements
--      — إنشاء حقيقي، لا مجرد تصحيح توقّع في دالة الفحص.
-- ---------------------------------------------------------------------
drop trigger if exists device_events_immutable on public.device_events;
create trigger device_events_immutable
  before update or delete on public.device_events
  for each row execute function public.forbid_evidence_mutation();

drop trigger if exists device_measurements_immutable on public.device_measurements;
create trigger device_measurements_immutable
  before update or delete on public.device_measurements
  for each row execute function public.forbid_evidence_mutation();

-- ---------------------------------------------------------------------
-- (3ب) check_evidence_trigger_integrity — أسماء مصحَّحة + evidence_chain_head
--      مُضافاً لقائمة الجداول المفحوصة.
-- ---------------------------------------------------------------------
create or replace function public.check_evidence_trigger_integrity()
returns table(
  table_name text,
  trigger_name text,
  is_enabled boolean
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  with evidence_tables as (
    select unnest(array[
      'decision_records', 'dust_evaluations', 'dust_compliance_evaluations',
      'pm10_readings_history', 'alert_state_events', 'device_readings_history',
      'final_decisions', 'admin_audit_log', 'device_events', 'device_measurements',
      'evidence_hash_ledger', 'evidence_anchor_runs', 'evidence_chain_head'
    ]) as tbl
  ),
  -- الاسم الفعلي لـtrigger الحماية من UPDATE/DELETE يختلف عن نمط
  -- {tbl}_immutable لجدول واحد فقط تاريخياً — dust_compliance_evaluations
  -- (الاسم الحقيقي compliance_evaluations_immutable، 202607290004). خريطة
  -- صريحة بدل نمط موحَّد يفترض تطابقاً غير موجود فعلياً.
  immutable_trigger_names as (
    select tbl,
      case tbl
        when 'dust_compliance_evaluations' then 'compliance_evaluations_immutable'
        else tbl || '_immutable'
      end as trg
    from evidence_tables
  ),
  expected_triggers as (
    select tbl, trg from immutable_trigger_names
    union all
    select tbl, tbl || '_no_truncate' as trg from evidence_tables
    union all
    select tbl, tbl || '_hash_chain_append' as trg
    from evidence_tables
    where tbl not in ('evidence_hash_ledger', 'evidence_anchor_runs', 'evidence_chain_head')
  )
  select
    e.tbl as table_name,
    e.trg as trigger_name,
    coalesce(t.tgenabled <> 'D', false) as is_enabled
  from expected_triggers e
  left join pg_class c on c.relname = e.tbl and c.relnamespace = 'public'::regnamespace
  left join pg_trigger t on t.tgrelid = c.oid and t.tgname = e.trg
  order by e.tbl, e.trg;
$$;

revoke all on function public.check_evidence_trigger_integrity() from public, anon, authenticated;
grant execute on function public.check_evidence_trigger_integrity() to service_role;

-- ---------------------------------------------------------------------
-- (4) genesis (202608110007) — تحقق دفاعي: أعِد حساب row_hash/chain_hash
--     المتوقَّعَين لصف __genesis__ بنفس الصيغة (extensions.digest صراحة)،
--     وقارنهما بالمخزَّن فعلياً. لا تصحيح رجعي على صف موجود بالفعل (append-
--     only، وقيمته إن كانت صحيحة أصلاً يجب ألا تُمَس) — فقط استثناء صريح لو
--     اكتُشف عدم تطابق فعلي (يعني فشل تطبيق الهجرة الأصلية بصمت أو تلاعب).
-- ---------------------------------------------------------------------
do $$
declare
  v_genesis record;
  v_expected_row_hash text;
  v_expected_chain_hash text;
begin
  select row_hash, chain_hash into v_genesis
  from public.evidence_hash_ledger
  where source_table = '__genesis__'
  limit 1;

  if not found then
    -- لا صف genesis بعد (سيناريو نظري: هجرة 202608110007 لم تُطبَّق على
    -- هذه القاعدة بعد بأي شكل) — لا شيء للتحقق منه هنا.
    return;
  end if;

  v_expected_row_hash := encode(extensions.digest('DCR-EVIDENCE-CHAIN-GENESIS', 'sha256'), 'hex');
  v_expected_chain_hash := encode(extensions.digest(v_expected_row_hash || v_expected_row_hash, 'sha256'), 'hex');

  if v_genesis.row_hash <> v_expected_row_hash or v_genesis.chain_hash <> v_expected_chain_hash then
    raise exception using errcode = '55000', message = format(
      'صف __genesis__ في evidence_hash_ledger لا يطابق القيمة المتوقَّعة (row_hash محفوظ=%s متوقَّع=%s) — تحقّق يدوياً قبل المتابعة (فشل تطبيق سابق محتمل أو تلاعب فعلي)',
      v_genesis.row_hash, v_expected_row_hash
    );
  end if;
end $$;

-- ---------------------------------------------------------------------
-- (2) append_evidence_hash_link → SECURITY DEFINER + search_path مقيَّد —
--     تُنفَّذ بصلاحيات المالك الآن (تحتاجها بعد سحب INSERT/UPDATE المباشرين
--     من service_role أدناه) — لا معامل نصي حر يقبل مدخلاً من المستدعي (كل
--     ما تقرأه TG_TABLE_NAME/NEW موفَّران تلقائياً من محرك الـtrigger، لا من
--     أي طرف خارجي)، فلا اتساع صلاحيات فعلي رغم SECURITY DEFINER.
-- ---------------------------------------------------------------------
create or replace function public.append_evidence_hash_link()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_row_hash text;
  v_previous_hash text;
  v_chain_hash text;
  v_row_created_at timestamptz;
  v_new_seq bigint;
begin
  v_row_hash := encode(digest(to_jsonb(NEW)::text, 'sha256'), 'hex');

  v_row_created_at := coalesce(
    (to_jsonb(NEW)->>'created_at')::timestamptz,
    (to_jsonb(NEW)->>'recorded_at')::timestamptz,
    now()
  );

  select last_hash into v_previous_hash
  from public.evidence_chain_head
  where id = true
  for update;

  v_chain_hash := encode(digest(v_row_hash || v_previous_hash, 'sha256'), 'hex');

  insert into public.evidence_hash_ledger (
    source_table, source_row_id, row_created_at, row_hash, previous_hash, chain_hash
  )
  values (TG_TABLE_NAME, NEW.id, v_row_created_at, v_row_hash, v_previous_hash, v_chain_hash)
  returning seq into v_new_seq;

  update public.evidence_chain_head
  set last_seq = v_new_seq,
      last_hash = v_chain_hash,
      updated_at = clock_timestamp()
  where id = true;

  return NEW;
end;
$$;

-- ---------------------------------------------------------------------
-- (1) سحب INSERT/UPDATE المباشرين من service_role — الكتابة الوحيدة
--     المتبقية على هذين الجدولين تمر الآن عبر append_evidence_hash_link()
--     (SECURITY DEFINER أعلاه، تعمل رغم سحب الصلاحية المباشرة). SELECT
--     يبقى (المراقبة/verify_evidence_*/evidence-anchor تحتاج القراءة).
-- ---------------------------------------------------------------------
revoke insert, update on public.evidence_hash_ledger from service_role;
revoke insert, update on public.evidence_chain_head from service_role;

comment on table public.evidence_hash_ledger is
  'دفتر تجزئة موحَّد لكل جداول الأدلة العشرة — append-only حصراً عبر append_evidence_hash_link() (SECURITY DEFINER، migration 202608120012). service_role لا يملك INSERT/UPDATE مباشرين — أي كتابة يجب أن تمر عبر trigger AFTER INSERT على جدول مصدر فعلي، لا استدعاء مباشر لهذا الجدول.';

comment on table public.evidence_chain_head is
  'صف واحد ثابت الهوية (id=true) يحمل ذيل evidence_hash_ledger الحالي — append_evidence_hash_link() (SECURITY DEFINER) هي الكاتب الوحيد المسموح (migration 202608120012 سحبت INSERT/UPDATE المباشرين من service_role).';
