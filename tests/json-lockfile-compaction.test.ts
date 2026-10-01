import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeJson } from '../src/intelligence/analyzers/json.js';

function analyze(file: string, value: unknown) {
  return analyzeJson({
    source: {
      id: `repo:${file}`,
      kind: 'repository-file',
      locator: file,
      revision: 'fixture',
      observedAt: new Date(0).toISOString(),
      available: true,
    },
    locatorBase: file,
    text: JSON.stringify(value),
  });
}

test('npm lockfiles retain package versions without materializing generated metadata', () => {
  const result = analyze('package-lock.json', {
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'fixture',
        version: '1.0.0',
        dependencies: { react: '^19.0.0' },
      },
      'node_modules/react': {
        version: '19.1.0',
        resolved: 'https://registry.npmjs.org/react/-/react-19.1.0.tgz',
        integrity: 'sha512-secretish-generated-hash',
        license: 'MIT',
        engines: { node: '>=18' },
        dev: false,
      },
      'node_modules/@scope/pkg': {
        version: '2.3.4',
        optional: true,
        os: ['linux'],
        bin: { pkg: 'cli.js' },
      },
    },
  });

  const fields = result.observations.map(item => item.field).sort();
  assert.deepEqual(fields, [
    'lockfileVersion',
    'name',
    'packages.node_modules/@scope/pkg.version',
    'packages.node_modules/react.version',
    'version',
  ]);
  assert.equal(result.observations.some(item => item.raw.includes('registry.npmjs.org')), false);
  assert.equal(result.observations.some(item => item.raw.includes('sha512-')), false);
  assert.equal(result.observations.some(item => item.field?.includes('license')), false);
  assert.equal(result.observations.some(item => item.field?.includes('engines')), false);
});

test('legacy npm lockfiles retain nested installed dependency versions', () => {
  const result = analyze('npm-shrinkwrap.json', {
    name: 'legacy',
    version: '1.0.0',
    lockfileVersion: 1,
    dependencies: {
      alpha: {
        version: '1.2.3',
        resolved: 'https://registry.invalid/alpha.tgz',
        dependencies: {
          beta: {
            version: '4.5.6',
            integrity: 'sha512-generated',
          },
        },
      },
    },
  });

  const byField = new Map(result.observations.map(item => [item.field, item.value]));
  assert.equal(byField.get('dependencies.alpha.version'), '1.2.3');
  assert.equal(byField.get('dependencies.alpha.dependencies.beta.version'), '4.5.6');
  assert.equal(result.observations.some(item => item.field?.includes('resolved')), false);
  assert.equal(result.observations.some(item => item.field?.includes('integrity')), false);
});

test('ordinary JSON keeps complete scalar representation analysis', () => {
  const result = analyze('config/runtime.json', {
    endpoint: '/api/items',
    nested: { retries: 3, enabled: true },
    list: ['alpha', 'beta'],
  });

  const fields = new Set(result.observations.map(item => item.field));
  assert.deepEqual(fields, new Set([
    'endpoint',
    'nested.retries',
    'nested.enabled',
    'list[0]',
    'list[1]',
  ]));
});
