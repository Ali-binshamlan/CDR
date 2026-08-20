import type { Metadata } from 'next';

// Public documentation page (unauthenticated) — the first public informational page in the app,
// located entirely outside app/dashboard/** so it bypasses requireUserId/RLS. Explains the
// POST /api/devices/ingest protocol to monitoring station vendors and project owners, enabling
// any external party (regardless of hardware brand) to integrate their station without custom engineering
// work from our side — a unified protocol for all instead of custom adapters per brand.
export const metadata: Metadata = {
  title: 'توثيق API | ربط أجهزة الرصد — DCR',
  description: 'دليل تقني لربط أي جهاز/محطة رصد خارجية بمنصة DCR عبر واجهة استقبال القراءات الحية.',
};

const codeBlockClass =
  'block bg-white border border-[#061B40]/10 rounded-lg p-3 text-[12px] font-mono text-[#061B40] overflow-x-auto whitespace-pre';
const inlineCodeClass = 'px-1.5 py-0.5 bg-[#F4F7FB] rounded text-[12px] font-mono';

interface FieldRow {
  field: string;
  unit: string;
  type: string;
  range: string;
}

// Device event contract — mandatory for every request (no grace period): request without these
// three fields is explicitly rejected with 400, regardless of any other valid measurement field.
const EVENT_CONTRACT_FIELDS: FieldRow[] = [
  { field: 'eventId', unit: '—', type: 'نص', range: 'غير فارغ، فريد لكل قراءة' },
  { field: 'sequence', unit: '—', type: 'رقم صحيح', range: '≥ 0، تصاعدي لكل جهاز' },
  { field: 'observedAt', unit: 'تاريخ/وقت ISO 8601', type: 'نص', range: 'ليس بالمستقبل' },
];

const FIELDS: FieldRow[] = [
  { field: 'windSpeedKmh', unit: 'كم/س', type: 'رقم', range: '≥ 0' },
  { field: 'windGustKmh', unit: 'كم/س', type: 'رقم', range: '≥ 0' },
  { field: 'windDirectionDeg', unit: 'درجة (اتجاه بوصلة)', type: 'رقم', range: '0 – 360' },
  { field: 'pm10', unit: 'ميكروجرام/م³', type: 'رقم', range: '≥ 0' },
  { field: 'pm25', unit: 'ميكروجرام/م³', type: 'رقم', range: '≥ 0' },
  { field: 'visibilityM', unit: 'متر', type: 'رقم', range: '≥ 0' },
  { field: 'relativeHumidityPercent', unit: '%', type: 'رقم', range: '0 – 100' },
  { field: 'temperatureC', unit: '°م', type: 'رقم', range: '-20 – 70' },
];

interface ErrorRow {
  status: string;
  cause: string;
  body: string;
}

const ERRORS: ErrorRow[] = [
  { status: '401', cause: 'رأس Authorization غير موجود في الطلب', body: '{ "error": "مفتاح الجهاز مطلوب" }' },
  {
    status: '401',
    cause: 'المفتاح غير صحيح، أو جهاز مُلغى (نفس الرسالة للحالتين — لا تمييز أمني بينهما)',
    body: '{ "error": "مفتاح جهاز غير صالح أو مُلغى" }',
  },
  { status: '400', cause: 'جسم الطلب ليس JSON صالحاً', body: '{ "error": "جسم الطلب يجب أن يكون JSON صالحاً" }' },
  { status: '400', cause: 'eventId غائب أو فارغ', body: '{ "error": "eventId إلزامي ويجب أن يكون نصاً غير فارغ" }' },
  {
    status: '400',
    cause: 'sequence غائب، أو سالب، أو كسري، أو ليس رقماً',
    body: '{ "error": "sequence إلزامي ويجب أن يكون رقماً صحيحاً غير سالب" }',
  },
  { status: '400', cause: 'observedAt غائب أو ليس نصاً', body: '{ "error": "observedAt إلزامي ويجب أن يكون نصاً بصيغة ISO" }' },
  { status: '400', cause: 'observedAt بصيغة غير صالحة', body: '{ "error": "observedAt ليس تاريخاً صالحاً" }' },
  { status: '400', cause: 'observedAt في المستقبل (فارق ساعة الجهاز)', body: '{ "error": "observedAt في المستقبل — تحقق من ساعة الجهاز" }' },
  {
    status: '400',
    cause: 'قيمة حقل قياس خارج النطاق المسموح أو ليست رقماً (يتوقف عند أول حقل فاشل)',
    body: '{ "error": "<رسالة خاصة بالحقل، مثال: windDirectionDeg يجب أن يكون بين 0 و360> " }',
  },
  {
    status: '400',
    cause: 'لا يوجد أي حقل قياس معروف في الطلب إطلاقاً',
    body: '{ "error": "يجب إرسال قيمة واحدة على الأقل من: windSpeedKmh، windGustKmh، windDirectionDeg، pm10، pm25، visibilityM" }',
  },
  { status: '500', cause: 'خطأ داخلي أثناء الحفظ في قاعدة البيانات', body: '{ "error": "<رسالة الخادم>" }' },
];

export default function DeviceIngestApiDocsPage() {
  return (
    <div className="min-h-screen bg-[#F4F7FB] text-[#061B40]" dir="rtl">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <header className="space-y-2">
          <p className="text-xs font-bold text-[#3995FF] uppercase tracking-wide">DCR — توثيق مطوّرين</p>
          <h1 className="text-2xl font-black">ربط جهاز/محطة رصد خارجية</h1>
          <p className="text-sm text-[#061B40]/70 leading-relaxed">
            هذا الدليل موجَّه لمورّدي محطات الرصد (أي نوع أو ماركة) ولأي شخص يبرمج تكامل جهاز رصد حقيقي
            (رياح، PM10، PM2.5، رؤية) مع منصة DCR. البروتوكول موحّد لكل الأجهزة — نقطة نهاية HTTP واحدة
            بمفتاح خاص لكل جهاز، بلا حاجة لأي تكامل مخصص من طرفنا.
          </p>
        </header>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-2">
          <h2 className="text-sm font-black">١. كيف تحصل على مفتاحك</h2>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            المفتاح يُنشئه صاحب المشروع بنفسه من لوحة التحكم: <strong>إعدادات المشروع ← قسم &quot;أجهزة الرصد الحية&quot;
            ← إضافة جهاز</strong>. المفتاح الخام يُعرض <strong>مرة واحدة فقط</strong> لحظة الإنشاء ولا يمكن استرجاعه
            لاحقاً بأي شكل — إن فُقد، الحل الوحيد هو تسجيل جهاز جديد بمفتاح جديد.
          </p>
        </section>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-black">٢. نقطة النهاية</h2>
          <code className={codeBlockClass} dir="ltr">POST /api/devices/ingest</code>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            كل طلب يجب أن يحمل رأس المصادقة التالي، بمفتاح الجهاز الخام (لا معرّف جهاز منفصل — الهوية تُشتق
            من المفتاح حصراً):
          </p>
          <code className={codeBlockClass} dir="ltr">{`Authorization: Bearer <مفتاحك>\nContent-Type: application/json`}</code>
        </section>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-black">٣. حقول عقد الحدث (إلزامية في كل طلب)</h2>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            هذه الحقول الثلاثة <strong>إلزامية دائماً</strong> — أي طلب لا يتضمنها يُرفض بـ400 بصرف النظر عن
            صحة حقول القياس. <span className={inlineCodeClass} dir="ltr">eventId</span> معرّف فريد لكل قراءة
            (يمنع تكرار الحفظ عند إعادة إرسال نفس الطلب)، <span className={inlineCodeClass} dir="ltr">sequence</span> رقم
            تسلسل تصاعدي لكل جهاز، و<span className={inlineCodeClass} dir="ltr">observedAt</span> وقت رصد القراءة
            الفعلي من الجهاز نفسه (لا وقت وصول الطلب للخادم) — يُرفض إن كان بالمستقبل أو أقدم من ٤٠ دقيقة.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] text-right border-collapse">
              <thead>
                <tr className="border-b border-[#061B40]/10 text-[#061B40]/50">
                  <th className="py-2 pr-2 font-bold">الحقل</th>
                  <th className="py-2 pr-2 font-bold">الوحدة</th>
                  <th className="py-2 pr-2 font-bold">النوع</th>
                  <th className="py-2 font-bold">النطاق المسموح</th>
                </tr>
              </thead>
              <tbody>
                {EVENT_CONTRACT_FIELDS.map((f) => (
                  <tr key={f.field} className="border-b border-[#061B40]/5">
                    <td className="py-2 pr-2 font-mono" dir="ltr">{f.field}</td>
                    <td className="py-2 pr-2">{f.unit}</td>
                    <td className="py-2 pr-2">{f.type}</td>
                    <td className="py-2 font-mono" dir="ltr">{f.range}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-black">٤. حقول القياس</h2>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            حقول القياس <strong>اختيارية فردياً</strong> — جهازك قد يملك مستشعراً واحداً فقط (مثلاً رياح فقط، أو
            PM فقط). يكفي إرسال حقل واحد على الأقل من الحقول الستة (بالإضافة لحقول عقد الحدث الإلزامية أعلاه).
            <strong> الكتابة جزئية:</strong> أي حقل قياس تتركه غائباً عن الطلب يبقي القيمة المخزَّنة سابقاً كما
            هي — لا يُصفِّرها.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] text-right border-collapse">
              <thead>
                <tr className="border-b border-[#061B40]/10 text-[#061B40]/50">
                  <th className="py-2 pr-2 font-bold">الحقل</th>
                  <th className="py-2 pr-2 font-bold">الوحدة</th>
                  <th className="py-2 pr-2 font-bold">النوع</th>
                  <th className="py-2 font-bold">النطاق المسموح</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((f) => (
                  <tr key={f.field} className="border-b border-[#061B40]/5">
                    <td className="py-2 pr-2 font-mono" dir="ltr">{f.field}</td>
                    <td className="py-2 pr-2">{f.unit}</td>
                    <td className="py-2 pr-2">{f.type}</td>
                    <td className="py-2 font-mono" dir="ltr">{f.range}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-black">٥. مثال طلب</h2>
          <code className={codeBlockClass} dir="ltr">
{`curl -X POST https://<دومين_موقعك>/api/devices/ingest \\
  -H "Authorization: Bearer <مفتاحك>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "eventId": "device-001-1732600970000",
    "sequence": 4821,
    "observedAt": "2026-07-26T09:02:50.000Z",
    "windSpeedKmh": 18.4,
    "pm10": 142.5,
    "pm25": 63.2,
    "visibilityM": 3000
  }'`}
          </code>
          <p className="text-[13px] text-[#061B40]/70">استجابة النجاح:</p>
          <code className={codeBlockClass} dir="ltr">
{`{ "success": true, "receivedAt": "2026-07-26T09:02:50.807Z" }`}
          </code>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            إن وصلت <span className={inlineCodeClass} dir="ltr">observedAt</span> بعمر أكبر من ٤٠ دقيقة وقت
            الاستلام الفعلي، تُقبَل القراءة ولا تُرفض — لكنها تُسجَّل في السجل التاريخي فقط لأغراض التدقيق/التحليل،
            بلا أي تأثير على الحالة التشغيلية الحية (آخر قراءة معروضة، حساب استمرار مخالفة PM10، إلخ). الاستجابة
            في هذه الحالة:
          </p>
          <code className={codeBlockClass} dir="ltr">
{`{ "success": true, "late": true, "receivedAt": "2026-07-26T09:02:50.807Z" }`}
          </code>
        </section>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-black">٦. حالات الخطأ</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] text-right border-collapse">
              <thead>
                <tr className="border-b border-[#061B40]/10 text-[#061B40]/50">
                  <th className="py-2 pr-2 font-bold">الحالة</th>
                  <th className="py-2 pr-2 font-bold">السبب</th>
                  <th className="py-2 font-bold">نص الاستجابة</th>
                </tr>
              </thead>
              <tbody>
                {ERRORS.map((e, i) => (
                  <tr key={i} className="border-b border-[#061B40]/5 align-top">
                    <td className="py-2 pr-2 font-mono font-bold" dir="ltr">{e.status}</td>
                    <td className="py-2 pr-2 text-[#061B40]/70">{e.cause}</td>
                    <td className="py-2 font-mono text-[11px]" dir="ltr">{e.body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-2">
          <h2 className="text-sm font-black">٧. كيف تُستخدم القراءة</h2>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            أي قراءة حديثة (خلال آخر ٢٠ دقيقة) تحل تلقائياً محل بيانات الطقس التقديرية في حساب قرار الامتثال
            الخاص بالمشروع — بأولوية أعلى من أي إدخال يدوي. قراءة أقدم من ذلك تُعامَل كأنها غير موجودة، ويرجع
            الحساب لمصادره المعتادة تلقائياً.
          </p>
        </section>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-2">
          <h2 className="text-sm font-black">٨. معدل الإرسال الموصى به</h2>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            لا يوجد حد أقصى صريح مفروض على عدد الطلبات حالياً. بما أن القراءة تُعتبر &quot;حديثة&quot; لمدة ٢٠ دقيقة فقط،
            يُنصح بالإرسال كل ٥ إلى ١٥ دقيقة لضمان بقاء القراءة فعّالة في القرار باستمرار.
          </p>
        </section>

        <footer className="text-[11px] text-[#061B40]/40 pt-4 border-t border-[#061B40]/10">
          هذا التوثيق يصف السلوك الفعلي لواجهة <span className={inlineCodeClass} dir="ltr">POST /api/devices/ingest</span> وقت كتابته. لأي استفسار، تواصل مع صاحب المشروع الذي زوَّدك بالمفتاح.
        </footer>
      </div>
    </div>
  );
}