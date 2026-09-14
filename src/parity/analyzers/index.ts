import path from 'node:path';
import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { analyzeTypeScript } from './typescript.js';
import { analyzeJson } from './json.js';
import { analyzeMarkdown } from './markdown.js';
import { analyzeHtml } from './html.js';

const EMPTY: AnalyzeResult = { observations: [], resolutions: [] };

export function analyzeByTechnology(context: AnalyzeContext): AnalyzeResult {
  const ext = path.extname(context.locatorBase).toLowerCase();
  try {
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return analyzeTypeScript(context);
    if (ext === '.json') return analyzeJson(context);
    if (['.md', '.mdx'].includes(ext)) return analyzeMarkdown(context);
    if (['.html', '.htm'].includes(ext)) return analyzeHtml(context);
    return EMPTY;
  } catch (error) {
    return {
      observations: [],
      resolutions: [{
        id: `analyzer-error:${context.source.id}`,
        from: null,
        to: null,
        kind: 'analysis',
        strategy: 'unresolved',
        confidence: null,
        status: 'unresolved',
        evidence: [error instanceof Error ? error.message : String(error)],
      }],
    };
  }
}

export { analyzeHtml } from './html.js';
export { analyzeJson } from './json.js';
