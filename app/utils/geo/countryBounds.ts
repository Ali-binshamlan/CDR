// حدود صلبة للمملكة العربية السعودية بالكامل — بطلب صريح من المستخدم:
// "عدّل الخريطة لتصبح على كامل السعودية، جميع الخرائط" (توسيع من حصر
// الرياض فقط سابقاً). صندوق إحداثيات يغطي كامل حدود المملكة، يُستخدم
// كـmaxBounds في كل خرائط Leaflet بالتطبيق (ProjectsMap،
// SinglePointMapPicker، MultiActivityMapPicker، ZonePicker) لمنع
// التكبير/السحب خارج المملكة. الاسم SAUDI_* (لا RIYADH_* القديم) يعكس
// النطاق الجديد.
export const SAUDI_BOUNDS: [[number, number], [number, number]] = [
  [16.0, 34.5], // جنوب غرب
  [32.5, 55.7], // شمال شرق
];

export const SAUDI_CENTER: [number, number] = [24.7136, 46.6753];
