import path from 'node:path';
import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { analyzeTypeScript } from './typescript.js';
import { analyzeJson } from './json.js';
import { analyzeMarkdown } from './markdown.js';
import { analyzeHtml } from './html.js';
import { analyzePolyglot } from './polyglot.js';
import { analyzeUnityMeta, analyzeUnitySerialized } from './unity.js';

const EMPTY: AnalyzeResult = { observations: [], resolutions: [] };

export const SOURCE_ANALYSIS_SUPPORT = [
  {
    technology: 'TypeScript/JavaScript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    precision: 'declarations, containment, modules, imports, re-exports, provable calls, and selected representation evidence',
  },
  {
    technology: 'C#',
    extensions: ['.cs'],
    precision: 'tree-sitter declarations, overload-aware identities, lexical containment, namespaces, and import bindings',
  },
  {
    technology: 'Java',
    extensions: ['.java'],
    precision: 'tree-sitter declarations, overload-aware identities, lexical containment, packages, and import bindings',
  },
  {
    technology: 'Python',
    extensions: ['.py'],
    precision: 'tree-sitter class/function/method identities, lexical containment, modules, and import bindings',
  },
  {
    technology: 'structured text',
    extensions: ['.json', '.md', '.mdx', '.html', '.htm'],
    precision: 'format-specific structure and representation evidence',
  },
  {
    technology: 'Unity serialized assets',
    extensions: ['.meta', '.unity', '.prefab', '.asset', '.mat', '.anim', '.controller', '.mixer'],
    precision: 'asset GUID identity, serialized objects, local object relationships, and uniquely provable cross-asset references',
  },
  {
    technology: 'Unity structured configuration',
    extensions: ['.asmdef', '.asmref', '.inputactions'],
    precision: 'JSON structure and representation evidence',
  },
] as const;

export function analyzeByTechnology(context: AnalyzeContext): AnalyzeResult {
  const ext = path.extname(context.locatorBase).toLowerCase();
  try {
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return analyzeTypeScript(context);
    if (['.json', '.asmdef', '.asmref', '.inputactions'].includes(ext)) return analyzeJson(context);
    if (['.md', '.mdx'].includes(ext)) return analyzeMarkdown(context);
    if (['.html', '.htm'].includes(ext)) return analyzeHtml(context);
    if (['.cs', '.java', '.py'].includes(ext)) return analyzePolyglot(context, ext);
    if (ext === '.meta') return analyzeUnityMeta(context);
    if (['.unity', '.prefab', '.asset', '.mat', '.anim', '.controller', '.mixer'].includes(ext)) return analyzeUnitySerialized(context);
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
