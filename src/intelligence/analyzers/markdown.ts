import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { observation } from '../model.js';

export function analyzeMarkdown(context: AnalyzeContext): AnalyzeResult {
  const observations = [];
  const lines = context.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) observations.push(observation({ sourceId: context.source.id, kind: 'document-heading', locator: `${context.locatorBase}:${index + 1}`, name: heading[2]!, field: 'heading', value: heading[2]! }));
    const bullet = /^[-*+]\s+(.{4,300})$/.exec(line);
    if (bullet) observations.push(observation({ sourceId: context.source.id, kind: 'document-statement', locator: `${context.locatorBase}:${index + 1}`, field: 'statement', value: bullet[1]! }));
    for (const match of line.matchAll(/https?:\/\/[^\s)\]>'"]+/g)) {
      observations.push(observation({ sourceId: context.source.id, kind: 'url-reference', locator: `${context.locatorBase}:${index + 1}:${match.index}`, name: match[0], field: 'url', value: match[0] }));
    }
  }
  return { observations, resolutions: [] };
}
