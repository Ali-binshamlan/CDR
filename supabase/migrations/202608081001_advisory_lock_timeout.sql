-- =====================================================================
-- DCR — 202608081001_advisory_lock_timeout.sql
-- =====================================================================
-- حادثة إنتاج فعلية (2026-08-08): pg_stat_activity أظهر 10 اتصالات
-- PostgREST (authenticator) عالقة بحالة wait_event_type=Lock/advisory —
-- كلها تنتظر نفس advisory lock (hashtextextended(project_id||':'||
-- activity_group_id)) الذي تأخذه persist_activity_decision_atomic
-- ودوال أخرى (19 استدعاء pg_advisory_xact_lock عبر المشروع، راجع
-- 202607290007/202608030005/202608030006/202608040009/.../202608060004).
-- أي اتصال واحد يمسك القفل ويتعطل (شبكة بطيئة، حمل عالٍ، تراكم طلبات
-- متزامنة) يجعل كل الاتصالات التالية على نفس القفل تنتظر بلا حد زمني —
-- تستهلك اتصالات connection pool الكاملة وتُسقط حتى طلبات بسيطة لا علاقة
-- لها بالقفل (بما فيها لوحة التحكم) بخطأ "Timed out acquiring connection
-- from connection pool" / HTTP 504.
--
-- الإصلاح: lock_timeout على مستوى الـrole (لا كل دالة على حدة — 19 موضع
-- عرضة لنسيان واحد منها) يجعل أي محاولة pg_advisory_xact_lock تفشل بخطأ
-- سريع بعد 5 ثوانٍ بدل الانتظار للأبد. الدالة المستدعية (evaluateProject.ts
-- وما شابه) تتعامل مع الفشل كخطأ عادي — retry لاحق عبر project_evaluation_jobs
-- (202608040004) أو enqueueEvaluationRetryJob، لا حاجة لتعديل SQL الدوال.
-- statement_timeout عام أعلى (30 ثانية) كخط دفاع ثانٍ ضد أي استعلام آخر
-- (لا advisory lock بالضرورة) يتعلق لأي سبب.
-- =====================================================================

alter role authenticator set lock_timeout = '5s';
alter role authenticator set statement_timeout = '30s';

alter role service_role set lock_timeout = '5s';
alter role service_role set statement_timeout = '30s';
