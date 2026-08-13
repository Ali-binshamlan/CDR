-- =====================================================================
-- DCR — 202608060003_rule_parameter_versioning.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "واجهة إدارة القواعد للعرض فقط؛
-- القواعد الفعلية ثابتة داخل دوال برمجية. لا يوجد نظام حقيقي يدعم: إنشاء
-- نسخة قاعدة، التحقق منها، اختبار التعارضات، النشر الذري، تحديد تاريخ
-- سريان، منع تعديل نسخة منشورة، التراجع لنسخة سابقة"):
--
-- محرك القواعد الفعلي (rulebook.ts/engine.ts) منطق برمجي (IF/THEN، ~1800
-- سطر) لا بيانات — تحويله بالكامل لمُفسِّر قواعد ديناميكي (DSL) هو تغيير
-- جذري عالي المخاطر على نظام امتثال تنظيمي (قرار المستخدم الصريح: تجنّب
-- ذلك). الإصلاح المُتفَق عليه (نطاق محدود، آمن): العتبات الرقمية القابلة
-- للضبط فعلياً في rulebook.ts (المسافات، سرعات الرياح، الأزمنة، النسب) —
-- لا عتبات PM10 التشغيلية (محمية صراحة، تبقى حصراً من ACTIVE_RULE_BUNDLE،
-- لا تُمس هنا إطلاقاً) — تُنقَل إلى نظام نسخ حقيقي بدلالة سجلّين:
--
-- rule_parameter_definitions: كتالوج ثابت (يُزرَع من الكود عبر seed مُرفَق
-- بهذه الهجرة نفسها — on conflict do nothing، لا من واجهة المستخدم لاحقاً)
-- لكل معامل قابل للضبط: اسمه الرمزي الفريد، نوعه، مداه الآمن (min/max)،
-- والقيمة الافتراضية الحالية المطابقة لما هو مكتوب في rulebook.ts/engine.ts
-- الآن بالضبط (fallback إن لم توجد نسخة PUBLISHED بعد — لا كسر توافقي عند
-- نشر هذه الهجرة؛ راجع resolveActiveRuleParameters في dustEvaluation.ts).
--
-- rule_parameter_versions: append-only، نسخة واحدة لكل نشر/تراجع. status
-- (DRAFT/PUBLISHED/SUPERSEDED/ARCHIVED) بدل UPDATE على الصف نفسه — نسخة
-- PUBLISHED لا تُعدَّل أبداً (immutability)، فقط تُستبدَل بنسخة PUBLISHED
-- جديدة (نشر عادي أو rollback، كلاهما "نسخة جديدة" تقنياً، لا استرجاع
-- للماضي). publish_rule_parameter_version (دالة ذرية أدناه) تضمن نسخة
-- PUBLISHED واحدة فقط في كل لحظة لكل معامل.
-- =====================================================================

create table if not exists public.rule_parameter_definitions (
  code text primary key,
  label_ar text not null,
  description_ar text not null,
  -- unit للعرض فقط (كم/س، متر، دقيقة، %، يوم) — لا يؤثر على أي حساب.
  unit text not null,
  value_type text not null default 'NUMBER' check (value_type in ('NUMBER', 'INTEGER')),
  -- مدى آمن (min/max) يُطبَّق داخل publish_rule_parameter_version أدناه —
  -- يمنع نشر قيمة عبثية (سالبة، صفر لعتبة يجب أن تكون موجبة، إلخ) لا علاقة
  -- لها بأي دليل تنظيمي فعلي.
  min_value numeric,
  max_value numeric,
  -- القيمة المكتوبة حالياً في الكود (rulebook.ts/engine.ts) وقت إنشاء هذه
  -- الهجرة — fallback الوحيد المستخدَم عند عدم وجود أي نسخة PUBLISHED بعد
  -- لهذا المعامل (لا يجوز أن يتوقف التقييم الحي بانتظار أول نشر).
  code_default_value numeric not null,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.rule_parameter_definitions enable row level security;
revoke all on public.rule_parameter_definitions from anon, authenticated;
grant select, insert, update on public.rule_parameter_definitions to service_role;

create table if not exists public.rule_parameter_versions (
  id uuid primary key default gen_random_uuid(),
  parameter_code text not null references public.rule_parameter_definitions(code) on delete cascade,
  value numeric not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED')),
  -- effective_from = متى تصبح هذه النسخة فعلية القراءة من resolveActiveRuleParameters
  -- (لا وقت الإدراج بالضرورة — يسمح بجدولة نشر مستقبلي، وإن كان publish
  -- الحالي يضبطه دائماً على "الآن" فوراً؛ العمود موجود لتوسّع لاحق آمن).
  effective_from timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  -- سبب النشر/التراجع (نص حر إلزامي عند النشر — تدقيق: "لماذا تغيّرت هذه
  -- القيمة تحديداً؟"). null فقط لنسخ DRAFT لم تُنشَر بعد.
  change_reason_ar text,
  -- true فقط للنسخة التي أُنشئت بفعل عملية rollback صريحة (لا نشر عادي) —
  -- تمييز تدقيقي: "هل هذا تغيير جديد أم عودة لقيمة سابقة؟"
  is_rollback boolean not null default false,
  -- النسخة PUBLISHED السابقة التي حلّت محلها هذه النسخة (null لأول نشر على
  -- الإطلاق لمعامل معيّن) — يبني سلسلة تاريخية قابلة للتتبع بلا استنتاج من
  -- الطابع الزمني وحده.
  supersedes_version_id uuid references public.rule_parameter_versions(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists idx_rule_parameter_versions_param_status
  on public.rule_parameter_versions (parameter_code, status);
create index if not exists idx_rule_parameter_versions_param_time
  on public.rule_parameter_versions (parameter_code, created_at desc);

-- نسخة PUBLISHED واحدة فقط في كل لحظة لكل معامل — الضمان الجوهري لسلامة
-- "ما القيمة الفعلية المُطبَّقة الآن؟" بلا لبس. فرضي جزئي (partial unique
-- index) بدل UNIQUE عادي لأن DRAFT/SUPERSEDED/ARCHIVED يجوز أن تتكرر بحرية.
create unique index if not exists uq_rule_parameter_versions_one_published
  on public.rule_parameter_versions (parameter_code)
  where status = 'PUBLISHED';

alter table public.rule_parameter_versions enable row level security;
revoke all on public.rule_parameter_versions from anon, authenticated;
grant select, insert, update on public.rule_parameter_versions to service_role;

-- =====================================================================
-- publish_rule_parameter_version — نشر ذرّي: يتحقق من المدى الآمن، يُنهي
-- (SUPERSEDED) النسخة PUBLISHED الحالية إن وُجدت، وينشئ النسخة الجديدة
-- PUBLISHED — كل ذلك في معاملة واحدة (قفل صف تعريف المعامل يمنع نشرين
-- متزامنين لنفس المعامل من التصادم).
-- =====================================================================
create or replace function public.publish_rule_parameter_version(
  p_parameter_code text,
  p_value numeric,
  p_published_by uuid,
  p_change_reason_ar text,
  p_is_rollback boolean default false,
  p_rollback_to_version_id uuid default null
)
returns public.rule_parameter_versions
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_min numeric;
  v_max numeric;
  v_previous_id uuid;
  v_new_row public.rule_parameter_versions;
begin
  if p_change_reason_ar is null or btrim(p_change_reason_ar) = '' then
    raise exception using errcode = '22023', message = 'change_reason_ar إلزامي عند النشر';
  end if;

  -- قفل صف التعريف — يمنع نشرين متزامنين لنفس المعامل من قراءة "لا نسخة
  -- منشورة حالياً" معاً ثم محاولة إدراج PUBLISHED مرتين (uq_..._one_published
  -- يمنع ذلك أيضاً على مستوى القيد، لكن القفل هنا يحوّل التعارض المحتمل إلى
  -- انتظار متسلسل آمن بدل خطأ 23505 عشوائي).
  select min_value, max_value into v_min, v_max
  from public.rule_parameter_definitions
  where code = p_parameter_code
  for update;

  if not found then
    raise exception using errcode = '23503', message = format('معامل غير معروف: %s', p_parameter_code);
  end if;

  -- خطأ مكتشَف ومُصلَح (تحقق حي بعد تطبيق الهجرة على الإنتاج): format() في
  -- PostgreSQL يشترط محدد نوع صريح لكل %s — % وحدها بلا حرف نوع كانت تسبب
  -- خطأ SQL فعلياً ("unrecognized format() type specifier") بدل رسالة
  -- الرفض العربية المقصودة، فيصل المستخدم خطأ داخلي غامض بدل سبب الرفض
  -- الحقيقي (القيمة خارج المدى الآمن).
  if v_min is not null and p_value < v_min then
    raise exception using errcode = '22023', message = format('القيمة %s أقل من الحد الأدنى الآمن %s', p_value, v_min);
  end if;
  if v_max is not null and p_value > v_max then
    raise exception using errcode = '22023', message = format('القيمة %s أعلى من الحد الأقصى الآمن %s', p_value, v_max);
  end if;

  select id into v_previous_id
  from public.rule_parameter_versions
  where parameter_code = p_parameter_code and status = 'PUBLISHED';

  if v_previous_id is not null then
    update public.rule_parameter_versions
    set status = 'SUPERSEDED'
    where id = v_previous_id;
  end if;

  insert into public.rule_parameter_versions (
    parameter_code, value, status, effective_from, published_by, published_at,
    change_reason_ar, is_rollback, supersedes_version_id, created_by
  ) values (
    p_parameter_code, p_value, 'PUBLISHED', clock_timestamp(), p_published_by, clock_timestamp(),
    p_change_reason_ar, coalesce(p_is_rollback, false),
    coalesce(p_rollback_to_version_id, v_previous_id), p_published_by
  )
  returning * into v_new_row;

  return v_new_row;
end;
$$;

revoke all on function public.publish_rule_parameter_version(text, numeric, uuid, text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.publish_rule_parameter_version(text, numeric, uuid, text, boolean, uuid) to service_role;

-- =====================================================================
-- rollback_rule_parameter_version — يعيد نشر قيمة نسخة سابقة (بأي حالة —
-- SUPERSEDED عادة) كنسخة PUBLISHED جديدة تماماً (append-only، لا تعديل
-- رجعي على الصف القديم). "تراجع" هنا يعني "انشر القيمة القديمة من جديد"،
-- لا "امسح ما حدث" — يحافظ على السجل التاريخي الكامل لكل نشر/تراجع.
-- =====================================================================
create or replace function public.rollback_rule_parameter_version(
  p_version_id uuid,
  p_published_by uuid,
  p_change_reason_ar text
)
returns public.rule_parameter_versions
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_target public.rule_parameter_versions;
  v_result public.rule_parameter_versions;
begin
  select * into v_target from public.rule_parameter_versions where id = p_version_id;
  if not found then
    raise exception using errcode = '23503', message = format('نسخة غير موجودة: %s', p_version_id);
  end if;

  select * into v_result from public.publish_rule_parameter_version(
    v_target.parameter_code, v_target.value, p_published_by, p_change_reason_ar, true, v_target.id
  );

  return v_result;
end;
$$;

revoke all on function public.rollback_rule_parameter_version(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.rollback_rule_parameter_version(uuid, uuid, text) to service_role;

-- append-only بعد النشر — نفس فلسفة forbid_evidence_mutation المطبَّقة على
-- جداول الأدلة (device_readings_history، إلخ): نسخة PUBLISHED/SUPERSEDED/
-- ARCHIVED لا يجوز تعديلها إطلاقاً بعد إنشائها (سجل تدقيق حقيقي، لا قابل
-- للتزوير الرجعي)، باستثناء انتقال الحالة الوحيد المسموح به فعلياً:
-- PUBLISHED→SUPERSEDED (الذي تكتبه publish_rule_parameter_version نفسها
-- عند نشر نسخة جديدة تحل محل القديمة) — أي تغيير آخر على أي عمود آخر، أو
-- أي انتقال حالة آخر، يُرفَض صراحة. DRAFT وحدها قابلة للتعديل الحر (لم
-- تُنشَر بعد، لا تأثير حي).
create or replace function public.forbid_published_rule_parameter_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'DRAFT' then
    return new;
  end if;

  if old.status = 'PUBLISHED' and new.status = 'SUPERSEDED'
     and new.value = old.value and new.parameter_code = old.parameter_code
     and new.published_at = old.published_at and new.published_by is not distinct from old.published_by
     and new.change_reason_ar = old.change_reason_ar and new.is_rollback = old.is_rollback
     and new.supersedes_version_id is not distinct from old.supersedes_version_id then
    return new;
  end if;

  raise exception using errcode = '0A000',
    message = 'rule_parameter_versions: لا يجوز تعديل نسخة منشورة/مُستبدَلة/مؤرشَفة إلا انتقال PUBLISHED→SUPERSEDED — append-only بعد النشر';
end;
$$;

drop trigger if exists trg_forbid_published_rule_parameter_mutation on public.rule_parameter_versions;
create trigger trg_forbid_published_rule_parameter_mutation
  before update on public.rule_parameter_versions
  for each row
  execute function public.forbid_published_rule_parameter_mutation();

-- =====================================================================
-- الزرع الأولي — كتالوج المعاملات القابلة للضبط، مقصور عمداً على العتبات
-- الرقمية "الآمنة للتعديل التشغيلي" في rulebook.ts/engine.ts: مسافات
-- المستقبِلات الحساسة، سرعات بوابات الرياح، حدود السرعة، الأزمنة، النسب.
-- مُستبعَد صراحةً: (1) عتبات PM10 التشغيلية/التنظيمية (340/250/...) — تبقى
-- حصراً من ACTIVE_RULE_BUNDLE (app/utils/rule-bundles)، طلب صريح من
-- المستخدم بعدم لمسها هنا؛ (2) عتبات تصنيف فئة المشروع (CATEGORY_I_MAX_AREA_M2،
-- حد 5000م²/50 رحلة في classifyProject) — هذه تُحدِّد الفئة التنظيمية
-- الأساسية للمشروع كاملاً (تشعبات واسعة جداً)، أعلى حساسية من عتبة تشغيلية
-- مفردة؛ تُترَك للنطاق المرحلي القادم إن طُلب صراحة.
-- code_default_value مطابقة تماماً لقيمة كل ثابت في rulebook.ts/engine.ts
-- وقت كتابة هذه الهجرة — أي انحراف مستقبلي بين القيمتين يعني أن نسخة
-- PUBLISHED فعلية موجودة وتتحكم فعلاً (السلوك المقصود تماماً).
insert into public.rule_parameter_definitions (code, label_ar, description_ar, unit, value_type, min_value, max_value, code_default_value) values
  ('CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M', 'مسافة الكسارة عن المستقبِل الحساس', 'الحد الأدنى لمسافة الكسارة عن أقرب مستقبِل حساس (سكني/مدرسي/صحي) — دون هذه المسافة تُفعَّل قاعدة CRUSHER-RECEPTOR-*.', 'متر', 'NUMBER', 0, 5000, 500),
  ('CRUSHER_GENERAL_RECEPTOR_DISTANCE_M', 'مسافة الكسارة عن المستقبِل العام', 'الحد الأدنى لمسافة الكسارة عن مستقبِل عام (غير حساس تحديداً).', 'متر', 'NUMBER', 0, 5000, 200),
  ('STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M', 'مسافة أكوام المواد عن المستقبِل الحساس', 'الحد الأدنى لمسافة تخزين/أكوام المواد عن أقرب مستقبِل حساس.', 'متر', 'NUMBER', 0, 5000, 200),
  ('DEMOLITION_MAX_AREA_M2', 'أقصى مساحة هدم بلا ضوابط إضافية', 'مساحة الهدم التي تتجاوزها تستوجب ضوابط إضافية.', 'م²', 'NUMBER', 0, 100000, 100),
  ('IDLE_SURFACE_MAX_DAYS', 'أقصى مدة سطح مكشوف غير نشط', 'عدد الأيام التي يجوز أن يبقى فيها سطح مكشوف غير نشط بلا تغطية إلزامية.', 'يوم', 'INTEGER', 0, 90, 5),
  ('UNPAVED_SPEED_LIMIT_KMH', 'حد سرعة الطرق غير المرصوفة', 'الحد الأقصى لسرعة الشاحنات/المعدات على الطرق الداخلية غير المرصوفة.', 'كم/س', 'NUMBER', 0, 60, 10),
  ('PAVED_SPEED_LIMIT_KMH', 'حد سرعة الطرق المرصوفة', 'الحد الأقصى لسرعة الشاحنات/المعدات على الطرق الداخلية المرصوفة.', 'كم/س', 'NUMBER', 0, 60, 20),
  ('SPILL_CLEANUP_LIMIT_MIN', 'مهلة تنظيف الانسكاب', 'الحد الأقصى بالدقائق لتنظيف أي انسكاب مواد على الطرق.', 'دقيقة', 'INTEGER', 0, 120, 15),
  ('DROP_HEIGHT_NORMAL_LIMIT_M', 'أقصى ارتفاع تفريغ (ظروف عادية)', 'الحد الأقصى لارتفاع تفريغ المواد السائبة في الظروف العادية.', 'متر', 'NUMBER', 0, 10, 1.5),
  ('DROP_HEIGHT_HIGH_WIND_LIMIT_M', 'أقصى ارتفاع تفريغ (رياح عالية)', 'الحد الأقصى لارتفاع تفريغ المواد السائبة أثناء رياح 15-25 كم/س.', 'متر', 'NUMBER', 0, 10, 1),
  ('DEBRIS_PILE_MAX_HEIGHT_M', 'أقصى ارتفاع كومة مخلفات', 'الحد الأقصى المسموح لارتفاع أكوام مخلفات الهدم/البناء.', 'متر', 'NUMBER', 0, 20, 3),
  ('IMMERSION_ZONE_MIN_LENGTH_M', 'أقصر طول لمنطقة الغمر (غسيل الإطارات)', 'الحد الأدنى لطول منطقة غمر/غسيل إطارات المركبات عند نقاط الخروج.', 'متر', 'NUMBER', 0, 50, 8),
  ('WHEEL_WASH_CYCLE_MIN_SEC', 'أقل مدة دورة غسيل إطارات', 'الحد الأدنى بالثواني لدورة غسيل إطارات واحدة عند نقاط الخروج.', 'ثانية', 'INTEGER', 0, 300, 20),
  ('STONE_CUTTING_WIND_STOP_KMH', 'سرعة إيقاف قطع الأحجار المكشوف', 'سرعة الرياح التي يجب إيقاف قطع الأحجار المكشوف عندها إلزامياً.', 'كم/س', 'NUMBER', 0, 100, 15),
  ('BATCHING_PM10_FILTER_MIN_PERCENT', 'أدنى كفاءة فلتر PM10 لمحطة الخلط', 'الحد الأدنى لكفاءة فلتر PM10 في الصوامع/محطات الخلط المغلقة للاستمرار أثناء إيقاف الرياح.', '%', 'NUMBER', 0, 100, 99),
  ('IDLE_SURFACE_COVER_INSPECTION_WIND_KMH', 'سرعة فحص أغطية الأسطح المكشوفة', 'سرعة الرياح التي تستوجب فحص أغطية الأسطح غير النشطة وإصلاحها فوراً.', 'كم/س', 'NUMBER', 0, 100, 20),
  ('WIND_GATE_ENHANCED_MIN_KMH', 'بداية نطاق الرياح المعزَّز (15-25)', 'سرعة الرياح التي يبدأ عندها تفعيل التثبيط المعزَّز (النطاق البرتقالي).', 'كم/س', 'NUMBER', 0, 100, 15),
  ('WIND_GATE_STOP_KMH', 'بداية نطاق إيقاف الرياح (فوق 25)', 'سرعة الرياح التي يُوقَف عندها إلزامياً الأنشطة المكشوفة المولّدة للغبار.', 'كم/س', 'NUMBER', 0, 100, 25),
  ('WIND_GUST_SAFETY_THRESHOLD_KMH', 'حد هبّة الرياح الاحترازية', 'سرعة هبّة الرياح العابرة التي تستوجب احترازاً إضافياً بلا اعتبارها مخالفة.', 'كم/س', 'NUMBER', 0, 150, 50),
  ('CONFIDENCE_MIN_FOR_ALLOW', 'أدنى ثقة مطلوبة للسماح التلقائي', 'الحد الأدنى لدرجة ثقة DVI اللازمة لإصدار قرار سماح تلقائي بلا تحفّظ.', '%', 'NUMBER', 0, 100, 70)
on conflict (code) do nothing;
