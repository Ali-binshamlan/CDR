import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { DEFAULT_RULE_PARAMETERS } from '@/app/utils/dust-compliance-engine';

/*
 * Bug Fix Note: Addressed external audit finding regarding rules management UI previously being view-only 
 * lacking version creation, atomic publication, published version immutability, and version rollback.
 * 
 * Overview: Returns the catalog of configurable parameters (`rule_parameter_definitions`) mapped to their active value 
 * (latest `PUBLISHED` version if present, falling back to `code_default_value`).
 * Refer to `migration 202608060003_rule_parameter_versioning.sql` and `app/utils/dust-compliance-engine/ruleParameters.ts` 
 * for full system architecture. POST endpoints for `publish` and `rollback` are housed in 
 * `app/api/admin/rule-parameters/[code]/publish|rollback/route.ts`.
 * 
 * Access Control: Strictly guarded by `requireSuperAdmin` (bypasses `verifyProjectOwnership` as these are global system parameters).
 */
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { data: definitions, error: defError } = await supabaseAdmin
    .from('rule_parameter_definitions')
    .select('code, label_ar, description_ar, unit, value_type, min_value, max_value, code_default_value')
    .order('code', { ascending: true });
  if (defError) return NextResponse.json({ error: safeErrorResponse(defError, 'rule-parameters definitions fetch failed') }, { status: 500 });

  const { data: published, error: pubError } = await supabaseAdmin
    .from('rule_parameter_versions')
    .select('id, parameter_code, value, published_at, published_by, change_reason_ar, is_rollback')
    .eq('status', 'PUBLISHED');
  if (pubError) return NextResponse.json({ error: safeErrorResponse(pubError, 'rule-parameters published fetch failed') }, { status: 500 });

  type PublishedRow = {
    id: string;
    parameter_code: string;
    value: number;
    published_at: string | null;
    published_by: string | null;
    change_reason_ar: string | null;
    is_rollback: boolean;
  };
  const publishedByCode = new Map<string, PublishedRow>(
    ((published as PublishedRow[]) || []).map((row) => [row.parameter_code, row])
  );

  type DefinitionRow = {
    code: string;
    label_ar: string;
    description_ar: string;
    unit: string;
    value_type: string;
    min_value: number | null;
    max_value: number | null;
    code_default_value: number;
  };
  const data = ((definitions as DefinitionRow[]) || []).map((def) => {
    const pub = publishedByCode.get(def.code);
    return {
      code: def.code,
      labelAr: def.label_ar,
      descriptionAr: def.description_ar,
      unit: def.unit,
      valueType: def.value_type,
      minValue: def.min_value,
      maxValue: def.max_value,
      codeDefaultValue: def.code_default_value,
      currentValue: pub?.value ?? def.code_default_value,
      isUsingCodeDefault: !pub,
      publishedVersionId: pub?.id ?? null,
      publishedAt: pub?.published_at ?? null,
      publishedBy: pub?.published_by ?? null,
      changeReasonAr: pub?.change_reason_ar ?? null,
      isRollback: pub?.is_rollback ?? false,
    };
  });

  /*
   * Visual verification payload: Returns `DEFAULT_RULE_PARAMETERS` to confirm DB `code_default_value` 
   * matches static defaults in `ruleParameters.ts` at request time (compared on client UI; divergence does not throw an error).
   */
  return NextResponse.json({ data, codeDefaults: DEFAULT_RULE_PARAMETERS });
}