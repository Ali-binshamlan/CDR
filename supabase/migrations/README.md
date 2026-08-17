# فهرس ملفات الهجرة (Migrations)

توثيق فقط — **لا يُحذف ولا يُعاد ترتيب أي ملف SQL بناءً على هذا الفهرس**.
الترقيم الزمني في اسم كل ملف (`YYYYMMDDHHNN_...`) هو ترتيب التطبيق الفعلي
على قاعدة البيانات ولا يجوز تغييره؛ إعادة تسمية أو حذف ملف مُطبَّق فعلاً
على أي بيئة يكسر تطابق `supabase_migrations.schema_migrations` مع محتوى
هذا المجلد. هذا الملف مجرد خريطة للتصفح السريع حسب الموضوع.

## جدول `projects` الأساسي وإنشاء المشاريع

- `202607290001_baseline_final.sql` — إنشاء المخطط الأساسي الكامل (كل الجداول، بما فيها `projects`).
- `202607290002_security_hardening.sql` — تصحيحات أمنية تراكمية بعد baseline مباشرة (RLS/صلاحيات).
- `202607290004_append_only_audit.sql` — أرشفة append-only + إضافة `archived_at`/`archived_by` على `projects`.
- `202608040009_archive_project_atomic.sql`, `202608040010_archived_project_write_guards.sql` — أرشفة المشروع كعملية ذرّية وحراسة الكتابة بعد الأرشفة.
- `202608110012_daily_duration_hours.sql` — حساب مدة الدوام اليومي.
- `202608110013_dust_profile_atomic_insert.sql`, `202608120003_fix_dust_profile_atomic_id_default.sql`, `202608120004_fix_dust_profile_atomic_id_default_v2.sql`, `202608160001_dust_profile_atomic_reject_group_id_collision.sql` — إدراج ملف نشاط الغبار الذرّي وتصحيحاته المتتالية.
- `202608120016_project_shifts_atomic.sql` — RPC ذرّية لإنشاء/تحديث المشروع مع الورديات (`create_project_with_shifts`/`update_project_with_shifts`).
- `202608130005_drop_true_north_calibration.sql` — حذف ميزة معايرة الشمال الحقيقي بالكامل (عمود `true_north_alignment_documented` على `projects` + 7 أعمدة على `project_devices`).
- `202608170001_fix_create_project_defaults.sql` — إصلاح فقدان القيم الافتراضية (`id`/`project_status`/...) في `create_project_with_shifts` بسبب `jsonb_populate_record`.

## الأجهزة والقراءات الحيّة (device events / ingest)

- `202607290003_sensor_events.sql` — جدول أحداث المستشعرات الأساسي.
- `202607290005_device_event_contract.sql` — عقد شكل حدث الجهاز.
- `202607290008_require_device_coordinates.sql` — إلزام إحداثيات الجهاز.
- `202608020004_atomic_device_ingest.sql`, `202608040027_merge_device_ingest_atomic.sql` — استيعاب حدث الجهاز كعملية ذرّية.
- `202608020006_add_missing_received_at_columns.sql` — أعمدة `received_at` الناقصة.
- `202608030003_device_deactivation_cascade_and_audit_fk.sql` — تعطيل الجهاز وتتبّعه.
- `202608040001_device_events_v2.sql`, `202608040002_ingest_device_event_v2.sql`, `202608040023_device_events_sequence_not_null.sql`, `202608040024_ingest_device_event_v2_require_sequence.sql` — نسخة v2 من استيعاب أحداث الجهاز مع ترقيم تسلسلي إلزامي.
- `202608040019_device_shift_composite_fks_not_valid.sql`, `202608040020_device_shift_composite_fks_validate.sql` — مفاتيح مركّبة بين الجهاز والوردية.
- `202608060001_device_true_north_calibration.sql` — إضافة معايرة الشمال الحقيقي (**أُلغيت لاحقاً بالكامل**، راجع `202608130005`).
- `202608060002_late_reading_history_no_state_mutation.sql` — قراءة متأخرة لا تُغيّر الحالة الحيّة.
- `202608091004_telemetry_ingestion_queue.sql`, `202608110016_telemetry_queue_event_key.sql`, `202608120002_telemetry_dead_letter.sql`, `202608120007_telemetry_complete_and_enqueue_atomic.sql` — طابور استيعاب القياسات عن بُعد (telemetry) والحرف الميت.
- `202608120001_manual_pm10_reading_endpoint.sql` — قراءة PM10 يدوية.
- `202608120006_device_ingest_future_timestamp_guard_and_pm10_last_at.sql` — حارس الطابع الزمني المستقبلي + آخر قراءة PM10.
- `202608130008_pm10_device_readings_realtime.sql` — بث قراءات PM10 الحيّة (Realtime).

## القرارات النهائية (final_decisions) والتنبيهات (alerts)

- `202607290007_atomic_decision_persist.sql` — حفظ القرار كعملية ذرّية.
- `202608020002_final_decisions_realtime_policy.sql` — سياسة Realtime على القرارات.
- `202608040011_persist_decision_archive_guard.sql`, `202608040012_decision_alert_outbox.sql`, `202608040013_persist_decision_outbox_intents.sql` — حفظ القرار مع حراسة الأرشفة وصندوق صادر (outbox) للتنبيهات.
- `202608040021_evaluation_run_snapshot_hash.sql`, `202608040022_persist_decision_evaluation_run.sql` — ربط القرار بدورة تقييم موثَّقة (hash + run).
- `202608040026_outbox_close_intents_and_alert_id.sql`, `202608040029_alerts_final_decision_id.sql`, `202608040034_outbox_status_allow_retry.sql` — نضج صندوق التنبيهات الصادر (إغلاق/إعادة محاولة).
- `202608060004_fix_outbox_conflict_target_mismatch.sql` — تصحيح تعارض هدف `ON CONFLICT` في outbox.
- `202608100001_final_decisions_state_change_skip.sql` — تخطّي كتابة قرار بلا تغيير فعلي في الحالة.
- `202608110005_final_decisions_rule_parameter_snapshot.sql`, `202608110006_persist_decision_rule_parameter_snapshot.sql` — لقطة معاملات القاعدة وقت اتخاذ القرار.
- `202608110020_outbox_protective_stop_and_violation.sql`, `202608110021_final_decision_guard_regulatory_finding.sql`, `202608110022_outbox_sequence_and_close_before_open.sql`, `202608110023_alerts_unique_active_and_outbox_retry_conflict.sql` — تصحيحات متتالية لحالات إيقاف/مخالفة وترتيب outbox.
- `202608130006_final_decisions_evaluation_links.sql` — ربط القرار بروابط دورة التقييم.
- `202608160002_evidence_rows_follow_final_decision_write.sql` — صفوف الأدلة تتبع كتابة القرار النهائي.
- `202608160003_drop_unused_alert_review_states.sql` — حذف حالات مراجعة تنبيه غير مستخدَمة.
- `202608160004_persist_decision_return_final_decision_id.sql` — إرجاع مُعرِّف القرار النهائي من دالة الحفظ.
- `202607290006_close_full_supabase_gap.sql` — نقل 4 تعديلات كانت فقط في مجلد قديم غير متتبَّع (`full-supabase/`) إلى مسار الهجرات الرسمي: `device_readings_history`، `final_decisions` (جدول كامل)، وربط `decision_records.final_decision_id`.

## سلسلة الأدلة والتدقيق (evidence hash chain)

- `202608110007_evidence_hash_ledger.sql`, `202608110008_evidence_hash_chain_trigger.sql`, `202608110009_evidence_anchor_runs.sql`, `202608110010_evidence_trigger_integrity_rpc.sql`, `202608110011_evidence_chain_verification_rpc.sql` — بناء سلسلة تجزئة (hash chain) للأدلة وتحقّق تكاملها.
- `202608120009_evidence_hash_chain_head.sql`, `202608120010_evidence_verify_against_source.sql`, `202608120011_evidence_chain_coverage_marker.sql`, `202608120012_evidence_chain_privileges_and_trigger_audit.sql` — رأس السلسلة، تحقّق من المصدر، تغطية، صلاحيات.
- `202608040030_evidence_profile_fk_restrict.sql` — قيد مفتاح أجنبي `RESTRICT` على ملف الدليل.
- `202608120015_fix_forbid_evidence_mutation_record_access.sql` — تصحيح وصول trigger منع التعديل.

## القفل والتزامن (locks / concurrency)

- `202608030008_scheduler_lock.sql` — قفل المجدوِل.
- `202608081001_advisory_lock_timeout.sql`, `202608081002_provider_pull_run_lock.sql` — مهلة القفل الاستشاري وقفل سحب المزوّد.
- `202608091001_replace_advisory_locks_with_row_locks.sql`, `202608091002_function_scoped_lock_timeout_and_activity_serialization.sql`, `202608091003_fix_on_conflict_composite_key_regression.sql` — استبدال الأقفال الاستشارية بأقفال صفوف + تسلسل الأنشطة.
- `202608110018_worker_lease_ownership.sql` — ملكية إيجار العامل (worker lease).
- `202608120013_worker_heartbeats.sql` — نبضات العامل الحيّة.
- `202608130001_scheduler_tick_run_lock.sql`, `202608130002_forecast_refresh_run_lock.sql` — قفل دورة المجدوِل وتحديث التوقعات.

## المزوّدون الخارجيون (providers) وبيانات الاعتماد

- `202608020001_provider_connections.sql`, `202608020005_archive_instead_of_delete.sql` (أرشفة اتصال المزوّد بدل حذفه) — اتصالات المزوّدين.
- `202608030001_disable_orphan_provider_connections.sql` — تعطيل اتصالات يتيمة.
- `202608040015_provider_instances.sql` — نسخ المزوّد (instances).
- `202608040016_provider_credentials_v2_columns.sql`, `202608040017_provider_credentials_v2_validate.sql`, `202608040018_provider_credentials_v2_cutover.sql` — ترحيل بيانات اعتماد المزوّد لنسخة v2.
- `202608040032_provider_connections_active_rpc.sql`, `202608040033_provider_connections_rpc_last_pull_at.sql` — RPC حالة الاتصال النشط وآخر سحب.
- `202608110014_provider_pull_cursor_columns.sql`, `202608110015_provider_connections_rpc_pull_cursor.sql` — مؤشر سحب (cursor) للمزوّد.
- `202608120008_backfill_cutover_guard.sql` — حارس تحقّق أن ترحيل بيانات الاعتماد (`credentials` → `credentials_ciphertext` enc:v2) اكتمل فعلياً قبل نشر كود يعتمد عليه حصراً.

## القواعد التنظيمية والمعاملات (rule parameters)

- `202608060003_rule_parameter_versioning.sql` — إصدارات معاملات القاعدة.
- `202608110003_rule_parameter_bundle_publishing.sql`, `202608110004_forbid_bundle_mutation.sql` — نشر حزمة معاملات ومنع تعديلها بعد النشر.
- `202608120005_wind_gate_parameter_relational_check.sql` — قيد علائقي على معامل بوابة الرياح.
- `202608170002_fix_stone_cutting_wind_stop_default.sql` — تصحيح `code_default_value` لمعامل `STONE_CUTTING_WIND_STOP_KMH` من 15 إلى 25 كم/س (مطابقة الكود الحي بعد إصلاح قاعدة قطع الأحجار).

## المجموعات والهويات المركّبة (activity_groups)

- `202608030005_fix_first_insert_cas_race.sql` — إصلاح تسابق CAS عند أول إدراج.
- `202608030006_composite_key_activity_group_id.sql` — مفتاح مركّب لهوية مجموعة النشاط.
- `202608040006_activity_groups_identity.sql` — هوية `activity_groups`.
- `202608040007_activity_composite_fks_not_valid.sql`, `202608040008_activity_composite_fks_validate.sql` — مفاتيح أجنبية مركّبة وتفعيلها.

## مهام التقييم (evaluation jobs) والدورات

- `202608040004_evaluation_jobs_and_runs.sql`, `202608040005_claim_evaluation_jobs.sql` — مهام التقييم والمطالبة بها.
- `202608040028_claim_evaluation_jobs_lease_recovery.sql` — استرداد إيجار مهمة متعثّرة.
- `202608110019_evaluation_jobs_observed_minute.sql` — دقيقة الرصد الفعلية للمهمة.
- `202608040003_forecast_snapshots.sql` — لقطات توقّعات الطقس.

## الأمان العام وصلاحيات الوصول

- `202608020003_close_direct_client_write_access.sql` — إغلاق الكتابة المباشرة من العميل.
- `202608030002_close_rls_grant_gaps.sql` — سد ثغرات صلاحيات RLS.
- `202608030004_alerts_realtime_publication.sql`, `202608130003_alerts_user_id_realtime_scope.sql` — نطاق نشر Realtime للتنبيهات.
- `202608030007_admin_audit_log_append_only.sql` — سجل تدقيق الإدارة append-only.
- `202608040014_forbid_truncate_and_default_privileges.sql` — منع `TRUNCATE` وصلاحيات افتراضية.
- `202608040031_outbox_revoke_truncate.sql` — سحب صلاحية `TRUNCATE` عن outbox.
- `202608110002b_drop_stale_persist_decision_overload.sql` — حذف نسخة قديمة متضاربة من دالة حفظ القرار.
- `202608120014_register_profile_atomic.sql` — تسجيل الملف الشخصي كعملية ذرّية.

## الأداء والصيانة (اكتُشفت أثناء تحقيقات إنتاجية فعلية)

- `202608081003_autovacuum_tuning_evidence_tables.sql` — ضبط autovacuum بعد انتفاخ جداول الأدلة.
- `202608110001_db_cleanup_function.sql`, `202608110002_evidence_size_monitoring_rpc.sql` — دالة تنظيف ومراقبة حجم جداول الأدلة.
- `202608130004_unused_indexes_monitoring_rpc.sql` — رصد الفهارس عديمة الاستخدام (`list_unused_indexes`).
- `202608130007_drop_confirmed_unused_indexes.sql` — حذف الفهارس المؤكَّدة عديمة الفائدة (بعد تحقيق ضغط Compute/CPU/Disk IO).

## PM10 والاستمرارية التنظيمية

- `202608040025_pm10_history_independent_timestamp.sql` — طابع زمني مستقل لسجل PM10.
- `202608110017_pm10_snapshot_only_evidence.sql` — تمييز أدلة اللقطة الفورية (snapshot-only) عن الاستمرار الحقيقي.

---

**ملاحظة:** أي ملف جديد يُضاف بترقيم زمني أحدث من آخر ملف موجود (`YYYYMMDDHHNN_وصف_مختصر.sql`)، ويُذكَر هنا تحت القسم الأنسب عند إضافته — لا حاجة لإعادة ترقيم أو نقل الملفات القديمة.
