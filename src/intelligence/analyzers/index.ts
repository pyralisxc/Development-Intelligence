import path from 'node:path';
import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { analyzeTypeScript } from './typescript.js';
import { analyzeJson } from './json.js';
import { analyzeMarkdown } from './markdown.js';
import { analyzeHtml } from './html.js';
import { analyzePolyglot } from './polyglot.js';
import { analyzeUnityMeta, analyzeUnitySerialized } from './unity.js';
import { analyzeCss } from './css.js';
import { analyzeSql } from './sql.js';
import { analyzeGo } from './go.js';
import { analyzeShell } from './shell.js';
import { analyzeRust } from './rust.js';
import { analyzeOperationalConfig, isOperationalConfigPath } from './operationalConfig.js';

const EMPTY: AnalyzeResult = { observations: [], resolutions: [] };

export const SOURCE_ANALYSIS_SUPPORT = [
  {
    technology: 'TypeScript/JavaScript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    precision: 'declarations, containment, modules, imports, re-exports, provable calls, component callback bindings, dynamic HTTP targets, state, navigation, RPC and selected representation evidence; bounded TypeScript compiler signatures add exact-callsite, file-to-declaration reference evidence for unique tracked cross-file symbols (static binding, not runtime dispatch)',
  },
  {
    technology: 'C#',
    extensions: ['.cs'],
    precision: 'tree-sitter declarations, overload-aware identities, lexical containment, namespaces, imports and conservatively bound calls and constructors; control-flow conditions and effects are not captured',
  },
  {
    technology: 'Java',
    extensions: ['.java'],
    precision: 'tree-sitter declarations, overload-aware identities, lexical containment, packages, and import bindings',
  },
  {
    technology: 'Rust',
    extensions: ['.rs'],
    precision: 'module, struct/enum/trait/type, function/method identities, use bindings, source containment, and conservative module relationships',
  },
  {
    technology: 'Go',
    extensions: ['.go'],
    precision: 'tree-sitter package, type/struct/interface and callable identities, lexical containment, imports, written conditions, candidate call expressions and same-package lexical target candidates; calls may be conversions and target binding and control-flow effects are not established',
  },
  {
    technology: 'Python',
    extensions: ['.py'],
    precision: 'tree-sitter class/function/method identities, lexical containment, modules, and import bindings',
  },
  {
    technology: 'PowerShell and shell',
    extensions: ['.ps1', '.psm1', '.psd1', '.sh', '.bash'],
    precision: 'tree-sitter function declarations, lexical containment and source-located written command and variable occurrences; variable values and bindings, dynamic command targets, invocation binding, arguments, conditions and execution are not established',
  },
  {
    technology: 'structured text',
    extensions: ['.json', '.md', '.mdx', '.html', '.htm'],
    precision: 'format-specific structure and representation evidence; npm lockfiles retain compact package/version identity while generated metadata remains source-searchable',
  },
  {
    technology: 'CSS',
    extensions: ['.css'],
    precision: 'selectors, declarations, at-rules, custom properties, and nesting context; source-to-selector usage is not inferred',
  },
  {
    technology: 'SQL',
    extensions: ['.sql'],
    precision: 'tables, functions/procedures, triggers, policies, indexes, privileges, and conservative routine read/write references',
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
  {
    technology: 'Operational/configuration text',
    extensions: ['.yml', '.yaml', 'Dockerfile*', '.env.example', '.env.sample', '.env.template', '.gitignore', '.dockerignore'],
    precision: 'bounded workflow/action keys, jobs, steps, references, commands, Docker build instructions, environment variable names, and ignore/source-boundary patterns; secret-like values are redacted',
  },
] as const;

const BASE_SUPPORTED_EXTENSIONS = new Set(
  SOURCE_ANALYSIS_SUPPORT.flatMap(entry => entry.extensions.filter(value => value.startsWith('.') && !value.includes('*'))),
);

export function supportsSourcePath(locatorBase: string): boolean {
  const ext = path.extname(locatorBase).toLowerCase();
  return BASE_SUPPORTED_EXTENSIONS.has(ext) || isOperationalConfigPath(locatorBase);
}

export function analyzeByTechnology(context: AnalyzeContext): AnalyzeResult {
  const ext = path.extname(context.locatorBase).toLowerCase();
  try {
    if (isOperationalConfigPath(context.locatorBase)) return analyzeOperationalConfig(context);
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return analyzeTypeScript(context);
    if (['.json', '.asmdef', '.asmref', '.inputactions'].includes(ext)) return analyzeJson(context);
    if (['.md', '.mdx'].includes(ext)) return analyzeMarkdown(context);
    if (['.html', '.htm'].includes(ext)) return analyzeHtml(context);
    if (ext === '.css') return analyzeCss(context);
    if (ext === '.sql') return analyzeSql(context);
    if (['.ps1', '.psm1', '.psd1'].includes(ext)) return analyzeShell(context, 'powershell');
    if (['.sh', '.bash'].includes(ext)) return analyzeShell(context, 'bash');
    if (ext === '.go') return analyzeGo(context);
    if (ext === '.rs') return analyzeRust(context);
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
export { analyzeCss } from './css.js';
export { analyzeSql } from './sql.js';
export { analyzeOperationalConfig, isOperationalConfigPath } from './operationalConfig.js';
