import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { listAvailableProviders } from '@/app/lib/providers/registry';

// List of registered external data source companies/Connectors in the system —
// used to populate the "Link Data Source" selection dropdown in the UI (settings/page.tsx).
// Any authenticated user can view this list (no specific project ownership required here).
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  return NextResponse.json({ providers: listAvailableProviders() });
}