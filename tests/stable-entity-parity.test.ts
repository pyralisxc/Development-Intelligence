import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTypeScript } from '../src/intelligence/analyzers/typescript.js';
import type { SourceDescriptor } from '../src/types.js';

const source: SourceDescriptor = {
  id: 'repo:src/sample.ts',
  kind: 'repository-file',
  locator: 'src/sample.ts',
  revision: 'fixture',
  observedAt: new Date(0).toISOString(),
  available: true,
};

test('symbol identity survives comment and line movement', () => {
  const first = analyzeTypeScript({ source, locatorBase: 'src/sample.ts', text: `export function alpha() { return 1; }` });
  const second = analyzeTypeScript({ source, locatorBase: 'src/sample.ts', text: `// moved by comments\n\n\nexport function alpha() { return 1; }` });
  const left = first.observations.find(node => node.kind === 'function' && node.name === 'alpha');
  const right = second.observations.find(node => node.kind === 'function' && node.name === 'alpha');
  assert.ok(left && right);
  const leftNode = left!;
  const rightNode = right!;
  assert.equal(leftNode.id, rightNode.id, 'line movement must not manufacture a new function identity');
  assert.notEqual(leftNode.locator, rightNode.locator, 'source location remains evidence and may move independently');
});

test('TypeScript overloads coalesce while genuinely distinct same-name symbols remain distinct', () => {
  const result = analyzeTypeScript({
    source,
    locatorBase: 'src/sample.ts',
    text: `
      export function parse(value: string): string;
      export function parse(value: number): number;
      export function parse(value: string | number) { return value; }

      export function outer() {
        { const task = () => 1; task(); }
        { const task = () => 2; task(); }
      }

      export class Runner {
        static run() { return 'static'; }
        run() { return 'instance'; }
      }
    `,
  });
  const overloads = result.observations.filter(node => node.kind === 'function' && node.name === 'parse');
  assert.equal(overloads.length, 1, 'overload declarations and implementation describe one structural symbol');
  const tasks = result.observations.filter(node => node.kind === 'function' && node.name === 'task');
  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0]!.id, tasks[1]!.id, 'distinct block-local declarations must not collide');
  const methods = result.observations.filter(node => node.kind === 'method' && node.name === 'run');
  assert.equal(methods.length, 2);
  assert.notEqual(methods[0]!.id, methods[1]!.id, 'static and instance members are distinct language symbols');
});

test('project-neutral source-adjacent declarations create stable semantic entities and evidence', () => {
  const result = analyzeTypeScript({
    source,
    locatorBase: 'src/sample.ts',
    text: `
      export const reality = [{
        developmentIntelligence: {
          kind: 'capability',
          id: 'sample.compare',
          label: 'Compare variants',
          category: 'interaction',
          relationships: [
            { kind: 'owned-by', to: 'feature:sample' },
            { kind: 'exposed-on', to: 'surface:workspace' },
          ],
        },
      }] as const;
    `,
  });
  const entity = result.observations.find(node => node.id === 'capability:sample.compare');
  assert.ok(entity);
  const semanticEntity = entity!;
  assert.equal(semanticEntity.layer, 'semantic');
  assert.equal(semanticEntity.checkpoint, true);
  assert.equal(semanticEntity.name, 'Compare variants');
  assert.ok(semanticEntity.evidenceIds?.length);
  assert.ok(result.resolutions.some(edge => edge.from === semanticEntity.id && edge.to === 'feature:sample' && edge.kind === 'owned-by' && edge.layer === 'semantic'));
  assert.ok(result.resolutions.some(edge => edge.from === semanticEntity.id && edge.to === 'surface:workspace' && edge.kind === 'exposed-on' && edge.layer === 'semantic'));
  assert.ok(result.evidence?.some(item => item.id === semanticEntity.evidenceIds?.[0]));
});

test('legacy or project-specific metadata names do not silently become DI semantics', () => {
  const result = analyzeTypeScript({
    source,
    locatorBase: 'src/sample.ts',
    text: `export const old = [{ productRealityKind: 'capability', id: 'sample.old', label: 'Old scanner metadata' }] as const;`,
  });
  assert.equal(result.observations.some(node => node.layer === 'semantic'), false);
});