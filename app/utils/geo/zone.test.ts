import { describe, it, expect } from 'vitest';
import { zoneToBoundaryDistanceM, nearestDistanceToBoundaryM, zoneSearchAnchorPoints, haversineDistanceM, type ProjectZone } from './zone';

describe('zoneToBoundaryDistanceM — أقرب مسافة فعلية لعنصر OSM كبير (way) بدل مركزه فقط', () => {
  it('حي سكني كبير: حافته القريبة أقرب بكثير من مركزه — يجب اعتماد الحافة لا المركز', () => {
    // دائرة تمثل مشروعاً صغيراً، وhay سكني (boundary) يمتد من قريب جداً من
    // المشروع إلى بعيد جداً عنه — مركز هذا الحي (نقطة المنتصف الحسابية بين
    // أقرب نقطة وأبعد نقطة) سيكون بعيداً بشكل مضلِّل عن المسافة الحقيقية.
    const zone: ProjectZone = {
      zoneType: 'circle',
      polygon: null,
      circleCenter: { lat: 24.7, lng: 46.7 },
      circleRadiusM: 50,
    };

    // نقطة حدودية قريبة جداً من المشروع (~30م خارج نصف القطر تقريباً) ونقطة
    // بعيدة جداً (~2 كم) — نفس عنصر way واحد يمتد بينهما.
    const boundary = [
      { lat: 24.7003, lng: 46.7 }, // قريبة (~33م عن المركز، ~أقل قليلاً عن الحافة)
      { lat: 24.72, lng: 46.7 },   // بعيدة (~2.2 كم)
    ];

    const nearestDistance = zoneToBoundaryDistanceM(zone, boundary);
    expect(nearestDistance).not.toBeNull();
    // يجب أن تكون المسافة قريبة من ~30م (الحافة القريبة)، لا ~1كم (لو
    // استُخدم متوسط/مركز النقطتين خطأً).
    expect(nearestDistance!).toBeLessThan(100);
  });

  it('boundary فارغة أو غير متوفرة → null، حتى يستخدم المستدعي مسافة centroid الاحتياطية', () => {
    const zone: ProjectZone = {
      zoneType: 'circle',
      polygon: null,
      circleCenter: { lat: 24.7, lng: 46.7 },
      circleRadiusM: 50,
    };
    expect(zoneToBoundaryDistanceM(zone, [])).toBeNull();
  });
});

describe('nearestDistanceToBoundaryM — أقرب مسافة من نقطة مفردة لأي نقطة حدودية', () => {
  it('يختار أقرب نقطة من عدة نقاط حدودية، لا أولها ولا متوسطها', () => {
    const point = { lat: 24.7, lng: 46.7 };
    const boundary = [
      { lat: 24.72, lng: 46.7 },   // بعيدة
      { lat: 24.7005, lng: 46.7 }, // قريبة جداً
      { lat: 24.71, lng: 46.7 },   // متوسطة
    ];
    const dist = nearestDistanceToBoundaryM(point, boundary);
    expect(dist).not.toBeNull();
    expect(dist!).toBeLessThan(100);
  });

  it('مصفوفة فارغة → null', () => {
    expect(nearestDistanceToBoundaryM({ lat: 24.7, lng: 46.7 }, [])).toBeNull();
  });
});

describe('zoneSearchAnchorPoints — نقاط انطلاق بحث Overpass من حدود المشروع الفعلية لا مركزه', () => {
  it('مضلع: يُرجع رؤوسه بالضبط (لا مركز ثقل واحد)', () => {
    const zone: ProjectZone = {
      zoneType: 'polygon',
      polygon: [
        { lat: 24.70, lng: 46.70 },
        { lat: 24.71, lng: 46.70 },
        { lat: 24.71, lng: 46.71 },
        { lat: 24.70, lng: 46.71 },
      ],
      circleCenter: null,
      circleRadiusM: null,
    };
    const anchors = zoneSearchAnchorPoints(zone);
    expect(anchors).toHaveLength(4);
    expect(anchors).toEqual(zone.polygon);
  });

  it('دائرة: يُرجع المركز بالإضافة إلى نقاط موزَّعة فعلياً على المحيط (لا المركز فقط)', () => {
    const center = { lat: 24.7, lng: 46.7 };
    const radiusM = 200;
    const zone: ProjectZone = { zoneType: 'circle', polygon: null, circleCenter: center, circleRadiusM: radiusM };
    const anchors = zoneSearchAnchorPoints(zone, 8);

    expect(anchors).toHaveLength(9); // المركز + 8 نقاط محيطية
    expect(anchors[0]).toEqual(center);

    // كل نقطة محيطية يجب أن تقع فعلياً على مسافة قريبة من نصف القطر عن
    // المركز (لا أن تساوي المركز نفسه، ولا أن تكون بعيدة عنه اعتباطياً) —
    // هذا ما يميّزها عن سلوك سابق كان يستخدم المركز فقط دوماً.
    for (const p of anchors.slice(1)) {
      const d = haversineDistanceM(center, p);
      expect(d).toBeGreaterThan(radiusM * 0.9);
      expect(d).toBeLessThan(radiusM * 1.1);
    }
  });

  it('point بلا هندسة مرسومة لكن بمركز افتراضي → نقطة واحدة فقط (لا حدود فعلية لتوزيع نقاط عليها)', () => {
    const zone: ProjectZone = { zoneType: 'point', polygon: null, circleCenter: { lat: 24.7, lng: 46.7 }, circleRadiusM: null };
    expect(zoneSearchAnchorPoints(zone)).toEqual([{ lat: 24.7, lng: 46.7 }]);
  });
});
