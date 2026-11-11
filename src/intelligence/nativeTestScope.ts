import type { IntelligenceGraph } from '../types.js';

/**
 * Expose the real native Node/AST test discovery scope. The default paths are
 * a convenience, NOT evidence that tests outside them do not exist.
 * All-supported expands from exact Git-tracked source paths; languages with
 * different runners require their own explicit producer and remain unknown.
 */
export const DEFAULT_NATIVE_TEST_SUFFIXES = [
  '.test.ts', '.test.mjs', '.test.js', '.test.tsx',
  '.spec.ts', '.spec.tsx', '.spec.js',
] as const;
export const DEFAULT_NATIVE_TEST_PREFIXES = ['tests/', 'scripts/', 'packaging/'] as const;

type ScopeInput = {
  sourcePrefixes?: string[];
  sourceSuffixes?: string[];
  allSupported?: boolean;
};
const PATH_SEGMENT = /^[a-zA-Z0-9_$@.+-][a-zA-Z0-9_$@./+-]*$/u;
function validScope(value: string): boolean {
  return typeof value === 'string' && value.length <= 1024
    && Boolean(value.trim()) && value === value.trim()
    && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && PATH_SEGMENT.test(value)
    && (value.endsWith('/') ? value.slice(0,-1) : value)
      .split('/').every(seg => Boolean(seg) && seg !== '.' && seg !== '..');
}
function distinct(values: readonly string[], kind: string): string[] {
  const unique = [...new Set(values)];
  if (!unique.length || unique.length > 50 || unique.some(x => !validScope(x))) {
    throw new Error('Native ' + kind + ' requires 1..50 canonical repository-relative selectors');
  }
  return unique.sort();
}
function filenameCandidate(value: string): boolean {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/iu.test(value);
}
export function deriveNativeTestScope(
  graph: IntelligenceGraph,
  input: ScopeInput = {},
): {
  scope: { sourcePrefixes: string[]; sourceSuffixes: string[] };
  discovery: {
    mode: 'default' | 'explicit' | 'all-supported';
    filenameCandidates: number;
    scopedFilenameCandidates: number;
    unselectedFilenameCandidates: number;
    unsupportedOrIncompleteScopedFiles: number;
    unselectedExamples: string[];
    negativeTestAbsenceProven: false;
    otherRunnerFrameworksCovered: false;
  };
} {
  if (input.allSupported && input.sourcePrefixes?.length) {
    throw new Error('Native all-supported source scope cannot silently combine with explicit prefixes');
  }
  const suffixes = distinct(
    input.sourceSuffixes?.length ? input.sourceSuffixes : [...DEFAULT_NATIVE_TEST_SUFFIXES],
    'test suffixes');
  const coverage = graph.coverage?.files ?? [];
  const candidates = coverage.filter(x => filenameCandidate(x.path));
  const includedSuffixes = candidates.filter(x => suffixes.some(s => x.path.endsWith(s)));
  let prefixes: string[];
  const mode = input.allSupported ? 'all-supported'
    : input.sourcePrefixes?.length || input.sourceSuffixes?.length ? 'explicit' : 'default';
  if (input.allSupported) {
    const dirs = includedSuffixes.map(x => {
      const first = x.path.indexOf('/');
      return first === -1 ? x.path : x.path.slice(0, first + 1);
    });
    prefixes = distinct(dirs.length ? dirs : [...DEFAULT_NATIVE_TEST_PREFIXES],
      'all-supported test prefix census');
  } else {
    prefixes = distinct(input.sourcePrefixes?.length
      ? input.sourcePrefixes : [...DEFAULT_NATIVE_TEST_PREFIXES],
      'test prefixes');
  }
  const selected = candidates.filter(x => prefixes.some(p => x.path.startsWith(p))
    && suffixes.some(s => x.path.endsWith(s)));
  const selectedIds = new Set(selected.map(x => x.path));
  const omitted = candidates.filter(x => !selectedIds.has(x.path));
  return {
    scope: { sourcePrefixes: prefixes, sourceSuffixes: suffixes },
    discovery: {
      mode,
      filenameCandidates: candidates.length,
      scopedFilenameCandidates: selected.length,
      unselectedFilenameCandidates: omitted.length,
      unsupportedOrIncompleteScopedFiles: selected.filter(x => x.status !== 'complete').length,
      unselectedExamples: omitted.slice(0, 12).map(x => x.path),
      negativeTestAbsenceProven: false,
      otherRunnerFrameworksCovered: false,
    },
  };
}
