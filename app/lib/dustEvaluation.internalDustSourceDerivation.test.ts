import { describe, it, expect } from 'vitest';
import { buildDustInput, deriveInternalDustSourceFromActivity } from './dustEvaluation';

// =====================================================================
// طلب مستخدم صريح: hasEarthworks/internalDirtRoads/looseMaterials
// (DustSiteInputs) لا مسار واجهة فعلي يملأها — القسم المسؤول في DustStep.tsx
// معطَّل بالكامل (SHOW_CONTROL_MEASURES_SECTION=false) ولا يضم أصلاً
// checkbox لهذه الثلاثة تحديداً، فالقيمة الخام من project_dust_profiles
// كانت دائماً false ثابتة، فيتعطل عملياً الشرط الثاني لـDVI-PM10-ACTION-003
// (pm10≥150 مع مصدر غبار داخلي واضح). deriveInternalDustSourceFromActivity
// تشتق القيمة تلقائياً من regulatory_activity نفسه بدل انتظار مدخل مستخدم
// غير موجود — كل نشاط من التسعة يحدد طبيعة مصدر غباره بدقة أعلى من هذه
// الفئات العامة الثلاث أصلاً.
// =====================================================================

const baseRow = {
  id: 'profile-1',
  has_earthworks: false,
  internal_dirt_roads: false,
  heavy_equipment_movement: false,
  loose_materials: false,
  surface_wet: false,
  watering_available: true,
  stockpiles_covered: true,
  speed_limit_applied: true,
  wheel_wash_available: true,
  dust_screens_available: true,
  field_monitoring_available: true,
  receptor_type: 'NONE_NEARBY',
  receptor_distance: 'OVER_500M',
  receptor_is_downwind: false,
  visible_dust_plume_reported: false,
  open_concrete_pour: false,
};

const baseProject = { id: 'project-1', latitude: 24.7136, longitude: 46.6753 };

describe('deriveInternalDustSourceFromActivity — الاشتقاق المباشر', () => {
  it('EARTHWORKS → hasEarthworks=true فقط، الحقلان الآخران false', () => {
    const r = deriveInternalDustSourceFromActivity('EARTHWORKS');
    expect(r.hasEarthworksFromActivity).toBe(true);
    expect(r.internalDirtRoadsFromActivity).toBe(false);
    expect(r.looseMaterialsFromActivity).toBe(false);
  });

  it('SITE_TRAFFIC → internalDirtRoads=true فقط', () => {
    const r = deriveInternalDustSourceFromActivity('SITE_TRAFFIC');
    expect(r.hasEarthworksFromActivity).toBe(false);
    expect(r.internalDirtRoadsFromActivity).toBe(true);
    expect(r.looseMaterialsFromActivity).toBe(false);
  });

  it('MATERIAL_HANDLING_STOCKPILE → looseMaterials=true فقط', () => {
    const r = deriveInternalDustSourceFromActivity('MATERIAL_HANDLING_STOCKPILE');
    expect(r.hasEarthworksFromActivity).toBe(false);
    expect(r.internalDirtRoadsFromActivity).toBe(false);
    expect(r.looseMaterialsFromActivity).toBe(true);
  });

  it('CD_WASTE_TRANSPORT → looseMaterials=true فقط (نفس تعليق "حمولة مكشوفة" في ACTIVITY_SENSITIVITY)', () => {
    const r = deriveInternalDustSourceFromActivity('CD_WASTE_TRANSPORT');
    expect(r.hasEarthworksFromActivity).toBe(false);
    expect(r.internalDirtRoadsFromActivity).toBe(false);
    expect(r.looseMaterialsFromActivity).toBe(true);
  });

  it('CRUSHER/DEMOLITION/BATCHING_PLANT/STONE_CUTTING/IDLE_SURFACE → الثلاثة الحقول false (مصدر غبارهم مغطى بحساسية النشاط الخاصة، لا علاقة له بهذه الفئات العامة)', () => {
    const keys = ['CRUSHER', 'DEMOLITION', 'BATCHING_PLANT', 'STONE_CUTTING', 'IDLE_SURFACE'] as const;
    keys.forEach((key) => {
      const r = deriveInternalDustSourceFromActivity(key);
      expect(r.hasEarthworksFromActivity).toBe(false);
      expect(r.internalDirtRoadsFromActivity).toBe(false);
      expect(r.looseMaterialsFromActivity).toBe(false);
    });
  });

  // طلب مستخدم صريح (نفس الفجوة، حقل رابع): heavyEquipmentMovement لا مسار
  // واجهة له هو الآخر (constants.ts يضبطه false ثابتة دائماً، بلا checkbox).
  // بخلاف largeExposedArea/drySurface (حُذفتا نهائياً من DustSiteInputs —
  // خصائص موقع فيزيائية بحتة، لا اشتقاق منطقي ممكن من النشاط)، حركة المعدات
  // الثقيلة صفة حقيقية لطبيعة نشاط محدد.
  it('CRUSHER/DEMOLITION/EARTHWORKS/CD_WASTE_TRANSPORT/MATERIAL_HANDLING_STOCKPILE → heavyEquipmentMovement=true (معدات ثقيلة كثيفة بطبيعة النشاط)', () => {
    const keys = ['CRUSHER', 'DEMOLITION', 'EARTHWORKS', 'CD_WASTE_TRANSPORT', 'MATERIAL_HANDLING_STOCKPILE'] as const;
    keys.forEach((key) => {
      const r = deriveInternalDustSourceFromActivity(key);
      expect(r.heavyEquipmentMovementFromActivity).toBe(true);
    });
  });

  it('SITE_TRAFFIC/BATCHING_PLANT/STONE_CUTTING/IDLE_SURFACE → heavyEquipmentMovement=false (لا حركة معدات ثقيلة مميِّزة لطبيعة النشاط نفسه)', () => {
    const keys = ['SITE_TRAFFIC', 'BATCHING_PLANT', 'STONE_CUTTING', 'IDLE_SURFACE'] as const;
    keys.forEach((key) => {
      const r = deriveInternalDustSourceFromActivity(key);
      expect(r.heavyEquipmentMovementFromActivity).toBe(false);
    });
  });
});

describe('buildDustInput — الاشتقاق مطبَّق فعلياً على site.* النهائية', () => {
  it('نشاط EARTHWORKS بعمود has_earthworks=false خام → site.hasEarthworks=true فعلياً (الاشتقاق يعوّض غياب مسار الواجهة)', () => {
    const input = buildDustInput({ ...baseRow, regulatory_activity: 'EARTHWORKS' }, baseProject);
    expect(input.site.hasEarthworks).toBe(true);
    expect(input.site.internalDirtRoads).toBe(false);
    expect(input.site.looseMaterials).toBe(false);
  });

  it('نشاط SITE_TRAFFIC → site.internalDirtRoads=true فعلياً', () => {
    const input = buildDustInput({ ...baseRow, regulatory_activity: 'SITE_TRAFFIC' }, baseProject);
    expect(input.site.internalDirtRoads).toBe(true);
    expect(input.site.hasEarthworks).toBe(false);
  });

  it('نشاط CRUSHER → الثلاثة تبقى false (لا اشتقاق له، ولا عمود خام يوفرها)', () => {
    const input = buildDustInput({ ...baseRow, regulatory_activity: 'CRUSHER' }, baseProject);
    expect(input.site.hasEarthworks).toBe(false);
    expect(input.site.internalDirtRoads).toBe(false);
    expect(input.site.looseMaterials).toBe(false);
  });

  it('عمود has_earthworks=true خام صريح (لو أُضيف مسار واجهة مستقبلاً) مع نشاط لا يشتق hasEarthworks → يبقى true (|| لا يُسقِط قيمة يدوية حقيقية)', () => {
    const input = buildDustInput({ ...baseRow, has_earthworks: true, regulatory_activity: 'CRUSHER' }, baseProject);
    expect(input.site.hasEarthworks).toBe(true);
  });

  it('نشاط CRUSHER بعمود heavy_equipment_movement=false خام → site.heavyEquipmentMovement=true فعلياً (الاشتقاق يعوّض غياب مسار الواجهة)', () => {
    const input = buildDustInput({ ...baseRow, regulatory_activity: 'CRUSHER' }, baseProject);
    expect(input.site.heavyEquipmentMovement).toBe(true);
  });

  it('نشاط SITE_TRAFFIC → site.heavyEquipmentMovement يبقى false (لا اشتقاق له)', () => {
    const input = buildDustInput({ ...baseRow, regulatory_activity: 'SITE_TRAFFIC' }, baseProject);
    expect(input.site.heavyEquipmentMovement).toBe(false);
  });
});
