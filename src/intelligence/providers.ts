export interface ProviderDefinition {
  id: string;
  label: string;
  imports: RegExp[];
  hosts: RegExp[];
}

export const PROVIDERS: ProviderDefinition[] = [
  { id: 'clerk', label: 'Clerk', imports: [/^@clerk\//u], hosts: [/clerk\.com/iu] },
  { id: 'supabase', label: 'Supabase', imports: [/^@supabase\//u], hosts: [/supabase\.(?:co|com)/iu] },
  { id: 'stripe', label: 'Stripe', imports: [/^stripe$/u, /^@stripe\//u], hosts: [/api\.stripe\.com/iu] },
  { id: 'google-drive', label: 'Google Drive', imports: [/^googleapis$/u, /^@googleapis\//u], hosts: [/drive\.googleapis\.com/iu, /www\.googleapis\.com\/drive/iu, /www\.googleapis\.com\/auth\/drive/iu] },
  { id: 'resend', label: 'Resend', imports: [/^resend$/u], hosts: [/api\.resend\.com/iu] },
  { id: 'meta', label: 'Meta', imports: [], hosts: [/graph\.facebook\.com/iu, /graph\.instagram\.com/iu] },
  { id: 'posthog', label: 'PostHog', imports: [/^posthog(?:-js|-node)?$/u], hosts: [/posthog\.com/iu] },
  { id: 'google-analytics', label: 'Google Analytics', imports: [], hosts: [/google-analytics\.com/iu, /googletagmanager\.com/iu] },
  { id: 'vercel', label: 'Vercel', imports: [/^@vercel\//u], hosts: [/api\.vercel\.com/iu, /vercel\.app/iu] },
];

export function detectProviders(importedSpecifiers: string[], source: string): Array<{ id: string; label: string; reason: string }> {
  const output = [] as Array<{ id: string; label: string; reason: string }>;
  for (const provider of PROVIDERS) {
    const byImport = provider.imports.some(pattern => importedSpecifiers.some(specifier => pattern.test(specifier)));
    const byHost = provider.hosts.some(pattern => pattern.test(source));
    if (!byImport && !byHost) continue;
    output.push({ id: provider.id, label: provider.label, reason: byImport ? 'provider import' : 'provider host' });
  }
  return output;
}
