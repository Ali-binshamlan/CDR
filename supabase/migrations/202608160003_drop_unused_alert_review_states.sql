-- =====================================================================
-- DCR — 202608160003_drop_unused_alert_review_states.sql
-- =====================================================================
-- طلب صريح من المستخدم (مراجعة كود — "حالات REVIEWED وACTION_TAKEN تظهر
-- في الواجهة، لكن مسار تغييرها حُذف؛ لا يوجد مسؤول أو وقت أو إجراء أو
-- مرفق"): REVIEWED/ACTION_TAKEN كانتا ضمن alert_state_events.new_state
-- CHECK منذ الإنشاء الأولي — لكن مسار الكتابة الوحيد الذي كان يمكنه إنتاج
-- أحدهما (PATCH /api/alerts/[alertId]) حُذف في commit 401af05
-- (2026-08-13) لأنه لم يكن مربوطاً بأي زر في الواجهة إطلاقاً منذ إضافته —
-- كود ميت. كل كاتب حي اليوم (insertAlert/autoCloseResolvedAlerts في
-- alerts/generate/route.ts، create_alert_atomic/close_alert_atomic) يكتب
-- فقط 'NEW' أو 'CLOSED'. سُئل المستخدم صراحة عن إعادة بناء الميزة (زر
-- فعلي + مسار كتابة) — الجواب: "هذه الميزة لا نريدها، احذفها".
--
-- الإصلاح: تضييق القيد ليطابق ما يُكتَب فعلياً فقط (NEW/CLOSED). لا هجرة
-- بيانات مطلوبة — لا صف بإحدى القيمتين المحذوفتين موجود أصلاً (لا كاتب حي
-- أنتجهما قط)، والتضييق نفسه يمنع أي كتابة مستقبلية بهما أيضاً — تناسق مع
-- إزالتهما من AlertState (app/dashboard/alerts/page.tsx) وSTATE_LABEL_AR
-- (AllAlertsTable.tsx) في نفس التغيير.
-- =====================================================================

alter table public.alert_state_events
  drop constraint if exists alert_state_events_new_state_check;

alter table public.alert_state_events
  add constraint alert_state_events_new_state_check
  check (new_state in ('NEW', 'CLOSED'));
