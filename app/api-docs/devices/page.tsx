import type { Metadata } from 'next';

// صفحة توثيق عامة (بلا تسجيل دخول) — أول صفحة معلوماتية عامة في التطبيق،
// خارج app/dashboard/** تماماً فلا تمر بأي requireUserId/RLS. تشرح بروتوكول
// POST /api/devices/ingest لمورّدي محطات الرصد وأصحاب المشاريع، حتى يقدر أي
// طرف خارجي (بأي ماركة جهاز) يربط محطته دون تدخّل برمجي منّا — بروتوكول
// موحّد واحد للجميع بدل جسور مخصصة لكل ماركة.
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
  {
    status: '400',
    cause: 'قيمة حقل خارج النطاق المسموح أو ليست رقماً (يتوقف عند أول حقل فاشل)',
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
            المفتاح يُنشئه صاحب المشروع بنفسه من لوحة التحكم: <strong>إعدادات المشروع ← قسم "أجهزة الرصد الحية"
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
          <h2 className="text-sm font-black">٣. شكل الطلب</h2>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            كل الحقول <strong>اختيارية فردياً</strong> — جهازك قد يملك مستشعراً واحداً فقط (مثلاً رياح فقط، أو
            PM فقط). يكفي إرسال حقل واحد على الأقل من الحقول الستة. <strong>الكتابة جزئية:</strong> أي حقل تتركه
            غائباً عن الطلب يبقي القيمة المخزَّنة سابقاً كما هي — لا يُصفِّرها.
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
          <h2 className="text-sm font-black">٤. مثال طلب</h2>
          <code className={codeBlockClass} dir="ltr">
{`curl -X POST https://<دومين_موقعك>/api/devices/ingest \\
  -H "Authorization: Bearer <مفتاحك>" \\
  -H "Content-Type: application/json" \\
  -d '{"windSpeedKmh": 18.4, "pm10": 142.5, "pm25": 63.2, "visibilityM": 3000}'`}
          </code>
          <p className="text-[13px] text-[#061B40]/70">استجابة النجاح:</p>
          <code className={codeBlockClass} dir="ltr">
{`{ "success": true, "receivedAt": "2026-07-26T09:02:50.807Z" }`}
          </code>
        </section>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-black">٥. حالات الخطأ</h2>
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
          <h2 className="text-sm font-black">٦. كيف تُستخدم القراءة</h2>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            أي قراءة حديثة (خلال آخر ٢٠ دقيقة) تحل تلقائياً محل بيانات الطقس التقديرية في حساب قرار الامتثال
            الخاص بالمشروع — بأولوية أعلى من أي إدخال يدوي. قراءة أقدم من ذلك تُعامَل كأنها غير موجودة، ويرجع
            الحساب لمصادره المعتادة تلقائياً.
          </p>
        </section>

        <section className="bg-white border border-[#061B40]/10 rounded-xl p-5 space-y-2">
          <h2 className="text-sm font-black">٧. معدل الإرسال الموصى به</h2>
          <p className="text-[13px] text-[#061B40]/70 leading-relaxed">
            لا يوجد حد أقصى صريح مفروض على عدد الطلبات حالياً. بما أن القراءة تُعتبر "حديثة" لمدة ٢٠ دقيقة فقط،
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
