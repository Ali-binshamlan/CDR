-- =====================================================================
-- DCR — 202608190004_device_evidence_storage_bucket.sql
-- =====================================================================
-- طلب مستخدم صريح: حقل "مرجع أو صورة الإثبات" في مودال توثيق الشمال
-- الحقيقي (project_devices.true_north_evidence_url) كان نص رابط فقط، بلا
-- أي آلية فعلية لرفع ملف — المستخدم يحتاج مصدراً خارجياً جاهزاً (Google
-- Drive مثلاً) ليلصق رابطه، وهذا غير عملي. لا يوجد أي bucket تخزين في
-- المشروع أصلاً (تحقَّقتُ: لا storage.buckets في أي هجرة سابقة، ولا
-- استخدام لـsupabase.storage في أي مسار API) — هذه الهجرة تُنشئ البنية
-- الأولى لرفع ملفات فعلي.
--
-- خاص (public=false) لا عام: صور/مستندات معايرة أجهزة رصد تخص مشروعاً
-- محدداً، لا يجوز أن تكون قابلة للوصول بمجرد تخمين الرابط. الرفع والقراءة
-- كلاهما يمران حصراً عبر service_role (API route خادمي يتحقق من ملكية
-- المشروع أولاً عبر verifyProjectOwnership، نفس نمط كل جدول حساس آخر في
-- هذا المشروع) — لا سياسة RLS مباشرة لـanon/authenticated على storage.objects،
-- فالوصول المباشر من المتصفح لهذا الـbucket غير ممكن إطلاقاً بأي مفتاح
-- عام، حتى لو عرف المستخدم اسم الملف.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'device-evidence',
  'device-evidence',
  false,
  5242880, -- 5MB — كافٍ لصورة تركيب جهاز أو شهادة مساحة PDF، يمنع رفع ملفات ضخمة عرضاً
  array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

-- لا سياسات RLS على storage.objects لـanon/authenticated لهذا الـbucket —
-- service_role يتجاوز RLS تلقائياً على أي حال (نفس مبدأ كل جدول آخر في
-- هذا المشروع لا يملك سياسة SELECT/INSERT مباشرة له)، فلا حاجة لإضافة أي
-- policy جديدة هنا — غيابها هو الحماية نفسها.
