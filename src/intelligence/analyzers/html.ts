import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { observation, resolution } from '../model.js';

function decode(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function strip(text: string): string {
  return decode(text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

export function analyzeHtml(context: AnalyzeContext): AnalyzeResult {
  const observations = [];
  const resolutions = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(context.text);
  if (title) observations.push(observation({ sourceId: context.source.id, kind: 'document-title', locator: `${context.locatorBase}:title`, name: strip(title[1]!), field: 'title', value: strip(title[1]!) }));

  const tagPattern = /<(a|button|form|input|h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?\s*>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = tagPattern.exec(context.text)) && index < 1000) {
    index += 1;
    const tag = (match[1] ?? match[4] ?? '').toLowerCase();
    const attrs = match[2] ?? match[5] ?? '';
    const inner = match[3] ?? '';
    const aria = /\baria-label=["']([^"']+)["']/i.exec(attrs)?.[1];
    const href = /\bhref=["']([^"']+)["']/i.exec(attrs)?.[1];
    const action = /\baction=["']([^"']+)["']/i.exec(attrs)?.[1];
    const method = /\bmethod=["']([^"']+)["']/i.exec(attrs)?.[1]?.toUpperCase();
    const name = aria ?? (strip(inner) || tag);
    const ui = observation({ sourceId: context.source.id, kind: tag.startsWith('h') ? 'heading' : 'ui-element', locator: `${context.locatorBase}:html:${match.index}`, name, field: 'element', value: { tag, label: name, href: href ?? null, action: action ?? null, method: method ?? null } });
    observations.push(ui);
    const target = href ?? action;
    if (target) {
      const route = observation({ sourceId: context.source.id, kind: 'route-reference', locator: `${context.locatorBase}:html:${match.index}:target`, name: target, field: href ? 'href' : 'action', value: { target, method: method ?? (href ? 'GET' : null) } });
      observations.push(route);
      resolutions.push(resolution({ from: ui.id, to: route.id, kind: href ? 'links_to' : 'submits_to', strategy: 'html', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:offset:${match.index}`] }));
    }
  }
  return { observations, resolutions };
}
