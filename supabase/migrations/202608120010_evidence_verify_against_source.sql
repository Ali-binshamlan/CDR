-- =====================================================================
-- DCR — 202608120010_evidence_verify_against_source.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "فحص Hash
-- لا يقارن السجل بالمصدر الأصلي"): verify_evidence_chain_tail (202608110011)
-- يُعيد حساب chain_hash فقط من row_hash/previous_hash *المخزَّنَين بالفعل*
-- داخل evidence_hash_ledger نفسه — لا يمس أبداً الصف الأصلي في final_decisions/
-- pm10_readings_history/device_readings_history/إلخ (الجدول الحقيقي الذي
-- source_table/source_row_id يشيران إليه). هذا يكتشف فقط تلاعباً بالدفتر
-- نفسه (evidence_hash_ledger) — بالضبط النطاق الذي وثّقه تعليق 202608110011
-- الأصلي ("أي تعديل مباشر على الدفتر... يُنتَج عدم تطابق يُكتشَف هنا"). لكن
-- التهديد الأخطر (موثَّق في تعليق 202608110007 الذي أنشأ هذا النظام أصلاً:
-- "دور postgres المالك يقدر ALTER TABLE ... DISABLE TRIGGER ALL، يعدّل بحرية،
-- ثم يعيد التفعيل") هو تعديل *الجدول المصدر نفسه* (مثال: تغيير pm10_ug_m3
-- في صف pm10_readings_history تاريخي مباشرة، بعد تعطيل trigger append_
-- evidence_hash_link مؤقتاً) — هذا لا يترك أي أثر في evidence_hash_ledger
-- (لم يُدرَج صف جديد، الصف القديم لم يُعدَّل)، فيبقى row_hash المخزَّن هناك
-- يطابق قيمة *قديمة* لم تعد تعكس الصف الحالي — verify_evidence_chain_tail
-- القديمة تُبلِغ "صالح" رغم التلاعب الفعلي، لأنها لا تقارن أصلاً بالمصدر.
--
-- الإصلاح: RPC جديدة (verify_evidence_source_integrity) تُعيد حساب row_hash
-- من to_jsonb(الصف الحالي الفعلي في الجدول المصدر) — نفس الصيغة بالضبط
-- المستخدَمة وقت الإدراج في append_evidence_hash_link (encode(digest(
-- to_jsonb(NEW)::text, 'sha256'), 'hex')) — وتقارنها بـevidence_hash_ledger.
-- row_hash المخزَّن. Dynamic SQL (EXECUTE format) لازم هنا لأن source_table
-- يختلف بين صفوف الدفتر (10 جداول مختلفة) — كل الجداول العشرة تستخدم عمود
-- id uuid كمفتاح أساسي (تحقَّق منه صراحة)، فالاستعلام الديناميكي آمن (لا حقن
-- SQL: source_table/source_row_id يأتيان من evidence_hash_ledger نفسه —
-- append-only، لا مدخل مستخدم مباشر — و%I/%L في format() يُهرِّبان الاسم/
-- القيمة بأمان على أي حال دفاعاً إضافياً).
--
-- صف محذوف (المصدر لم يعد موجوداً — جدول الأدلة نفسه append-only فلا يُفترَض
-- حذفه أبداً، فغيابه دليل تلاعب حتمي لا احتمال آخر) يُبلَّغ صراحةً كحالة
-- منفصلة (source_row_missing=true)، لا كـ"صالح" بغياب مقارنة ولا كخطأ SQL
-- عام يُسقِط الاستعلام كله.
--
-- تحذير موثَّق صراحة (لا يُخفى): to_jsonb(الصف الحالي) قد يختلف شكلاً عن
-- to_jsonb(NEW) وقت الإدراج الأصلي لو تغيّر مخطط الجدول لاحقاً (عمود أُضيف/
-- حُذف) — عدم تطابق ناتج عن ذلك تحديداً (لا تلاعب فعلي بالقيم) ممكن نظرياً
-- بعد أي migration يُعدِّل عمود جدول أدلة (نادر: هذه الجداول شبه ثابتة
-- الشكل بتصميم النظام). لا حل عام لهذا القيد ضمن هذه الدالة — يبقى قيداً
-- معروفاً في تصميم "hash كامل الصف" نفسه، موروث من append_evidence_hash_link
-- الأصلية، لا شيء تُصلحه هذه الهجرة بمفردها.
-- =====================================================================

create or replace function public.verify_evidence_source_integrity(p_window integer default 50)
returns table(
  seq bigint,
  source_table text,
  source_row_id uuid,
  source_row_missing boolean,
  is_valid boolean,
  expected_row_hash text,
  stored_row_hash text
)
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
stable
as $$
declare
  v_ledger_row record;
  v_source_json text;
  v_expected_hash text;
begin
  for v_ledger_row in
    select el.seq, el.source_table, el.source_row_id, el.row_hash
    from public.evidence_hash_ledger el
    where el.source_table <> '__genesis__'
    order by el.seq desc
    limit greatest(p_window, 1)
  loop
    -- جدول الدفتر نفسه (evidence_hash_ledger) ليس ضمن قائمة الجداول
    -- العشرة — source_table يشير دائماً إلى أحدها فقط (append_evidence_
    -- hash_link مُطبَّقة عبر trigger على تلك العشرة حصراً، راجع 202608110008).
    -- عمود id uuid موجود في العشرة كلها (تحقَّق منه صراحة أعلى الملف) —
    -- استعلام موحَّد بلا حالة خاصة لكل جدول.
    begin
      execute format(
        'select to_jsonb(t)::text from public.%I t where t.id = %L',
        v_ledger_row.source_table, v_ledger_row.source_row_id
      ) into v_source_json;
    exception
      when undefined_table then
        -- source_table لم يعد موجوداً إطلاقاً (سيناريو غير متوقَّع، جدول
        -- أدلة لا يُحذَف بتصميم النظام) — يُعامَل كصف مفقود، لا خطأ يُسقِط
        -- الاستعلام كله.
        v_source_json := null;
    end;

    if v_source_json is null then
      seq := v_ledger_row.seq;
      source_table := v_ledger_row.source_table;
      source_row_id := v_ledger_row.source_row_id;
      source_row_missing := true;
      is_valid := false;
      expected_row_hash := null;
      stored_row_hash := v_ledger_row.row_hash;
      return next;
      continue;
    end if;

    -- نفس الصيغة بالضبط المستخدَمة في append_evidence_hash_link وقت
    -- الإدراج (202608110008/202608120009) — encode(digest(to_jsonb(NEW)::text, 'sha256'), 'hex').
    v_expected_hash := encode(digest(v_source_json, 'sha256'), 'hex');

    seq := v_ledger_row.seq;
    source_table := v_ledger_row.source_table;
    source_row_id := v_ledger_row.source_row_id;
    source_row_missing := false;
    is_valid := (v_expected_hash = v_ledger_row.row_hash);
    expected_row_hash := v_expected_hash;
    stored_row_hash := v_ledger_row.row_hash;
    return next;
  end loop;
end;
$$;

revoke all on function public.verify_evidence_source_integrity(integer) from public, anon, authenticated;
grant execute on function public.verify_evidence_source_integrity(integer) to service_role;

comment on function public.verify_evidence_source_integrity(integer) is
  'يُعيد حساب row_hash من الصف الفعلي الحالي في الجدول المصدر (source_table/source_row_id) ويقارنه بـevidence_hash_ledger.row_hash المخزَّن — يكتشف تعديلاً أو حذفاً للصف المصدر نفسه (لا فقط تلاعباً بالدفتر، الذي تغطيه verify_evidence_chain_tail المنفصلة). source_row_missing=true يعني الصف الأصلي لم يعد موجوداً — دليل تلاعب حتمي (جداول الأدلة append-only بتصميم النظام).';
