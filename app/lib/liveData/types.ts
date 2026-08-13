// طبقة "Live Data" — الحالة الحيّة الحالية لكل جهاز، منفصلة تماماً عن
// التخزين الدائم (Supabase). الهدف: الواجهة تقرأ آخر قراءة بسرعة من هنا
// بدل ضرب Supabase مباشرة لكل تحديث دوري/كل مستخدم مفتوح — راجع التقرير
// التشخيصي (2026-08-08) الذي حدد هذا كنقطة الضعف المعمارية الوحيدة
// المتبقية بعد إصلاح أسباب التعليق الثلاثة (advisory lock timeout،
// provider_pull_run_lock، autovacuum tuning — جميعها migrations
// 202608081001-3). لا علاقة لهذه الطبقة بسبب أي تعليق سابق؛ هي تحسين
// معماري وقائي (hardening)، لا علاج عطل قائم.
//
// LiveDataStore واجهة مجرّدة عمداً — التنفيذ الحالي (inMemoryStore.ts) هو
// Map داخل عملية Node واحدة، كافٍ لخادم واحد. أي تنفيذ بديل (Redis) يطابق
// نفس الواجهة بلا أي تغيير على المستهلكين (deviceReadingWriter.ts، SSE
// route). قيد معروف وموثَّق صراحة: التنفيذ الحالي غير مشترك بين عدة
// instances من الخادم (كل instance له Cache خاص) — لا مشكلة على Vercel
// بخادم واحد فعّال لكل مشروع الآن، لكن يصبح قيداً حقيقياً عند التوسع لعدة
// instances متزامنة؛ الاستبدال بـRedis هو الحل الموثَّق لذلك حين يلزم.

export interface LiveDeviceSnapshot {
  deviceId: string;
  projectId: string;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  windDirectionDeg: number | null;
  pm10: number | null;
  pm25: number | null;
  visibilityM: number | null;
  relativeHumidityPercent: number | null;
  temperatureC: number | null;
  // ISO — وقت آخر قراءة فعلية (observedAt)، لا وقت تحديث الـcache نفسه.
  observedAtIso: string;
  // ISO — وقت كتابة هذا الـsnapshot في الـcache (لحساب قِدَم البيانات
  // المعروضة في الواجهة إن احتيج، مستقل عن observedAtIso).
  updatedAtIso: string;
}

// حدث يُبث لكل مشترك عند تحديث جهاز — نفس شكل الـsnapshot زائد نوع الحدث،
// يسمح لاحقاً بإضافة أنواع أخرى (مثال: 'device_offline') بلا كسر العقد.
export interface LiveDataEvent {
  type: 'snapshot';
  snapshot: LiveDeviceSnapshot;
}

export type LiveDataListener = (event: LiveDataEvent) => void;

export interface LiveDataStore {
  // يكتب/يستبدل آخر حالة معروفة لجهاز، ويبث الحدث فوراً لكل المشتركين على
  // نفس المشروع. لا ينتظر أي عملية I/O خارجية — يجب أن يكون متزامناً
  // (synchronous) أو شبه-فوري دائماً (Redis لاحقاً: async بسيط، لا معاملات).
  setSnapshot(snapshot: LiveDeviceSnapshot): void;

  // آخر حالة معروفة لجهاز واحد، أو null إن لم تُكتب أي قراءة بعد منذ إقلاع
  // العملية الحالية (فرق مهم عن "لا توجد قراءات في Supabase إطلاقاً" — راجع
  // القيد أعلاه بخصوص عدم المشاركة بين instances).
  getSnapshot(deviceId: string): LiveDeviceSnapshot | null;

  // كل الأجهزة المعروفة لمشروع معيّن — تُستخدم لبناء الحالة الأولية عند فتح
  // اتصال SSE جديد (قبل أي حدث جديد يصل).
  getProjectSnapshots(projectId: string): LiveDeviceSnapshot[];

  // اشتراك بتحديثات مشروع معيّن — يُستدعى listener لكل جهاز تابع لهذا
  // المشروع فقط. يُعيد دالة إلغاء الاشتراك.
  subscribeToProject(projectId: string, listener: LiveDataListener): () => void;
}
