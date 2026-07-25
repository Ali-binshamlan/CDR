import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { fetchDustWeather } from '@/app/utils/dust-engine/weather';

// قراءات طقس/جودة هواء حية لموقع واحد (سرعة رياح، اتجاهها، PM10، PM2.5) —
// يُستخدم من بطاقة الهوفر بخريطة المشاريع (ProjectsMap.tsx) لعرض قراءات
// لحظية عند مؤشر المشروع. استثناء متعمَّد للقاعدة الصارمة في dust-engine/
// types.ts ("لا نعرض رقماً خاماً للمستخدم") — هنا نظرة عامة عبر الخريطة،
// لا شاشة قرار تشغيلي لنشاط محدد، فعرض القراءة الخام مفيد للمراقبة.
// جلب كسول فقط عند الهوفر (لا يُستدعى دفعة واحدة لكل مشاريع الخريطة) —
// تجنّباً لإغراق Open-Meteo بعشرات النداءات المتزامنة عند تحميل الخريطة.
//
// جُرِّب IQAir بديلاً لـPM10/PM2.5 (مؤشر AQI فقط) لكن أُرجِع: حده المجاني
// ~2-3 طلبات/دقيقة قبل 429 (تحقّقنا فعلياً)، فكان الهوفر الثاني على أي
// نقطة يفشل بصمت خلال ثوانٍ من الأول — غير صالح للاستخدام التفاعلي هنا.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const lat = Number(request.nextUrl.searchParams.get('lat'));
  const lng = Number(request.nextUrl.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'lat و lng مطلوبان وصالحان' }, { status: 400 });
  }

  const weather = await fetchDustWeather(lat, lng);
  return NextResponse.json({ data: weather });
}
