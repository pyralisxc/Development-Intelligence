import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeByTechnology } from '../src/intelligence/analyzers/index.js';
import { buildRepositoryGraph } from '../src/intelligence/repository.js';
import { runChecked } from '../src/util/process.js';
import type { AnalyzeResult } from '../src/intelligence/model.js';

function analyze(file: string, text: string): AnalyzeResult {
  return analyzeByTechnology({
    source: { id: `repo:${file}`, kind: 'repository-file', locator: file, revision: null, observedAt: '2026-01-01T00:00:00.000Z', available: true },
    locatorBase: file,
    text,
  });
}

function symbol(result: AnalyzeResult, kind: string, name: string) {
  return result.observations.find(item => item.kind === kind && item.name === name);
}

test('C# analysis preserves namespace, type, member, overload, and containment identities', () => {
  const source = `namespace Demo.Core;
public interface IService { void Run(); }
public sealed class Worker : IService {
  private int count, retries;
  public string Name { get; init; } = "worker";
  public Worker(int count) { this.count = count; }
  public void Run() { }
  public void Run(string mode) { }
}`;
  const result = analyze('src/Worker.cs', source);
  const moved = analyze('src/Worker.cs', `// leading comment\n\n${source}`);
  const worker = symbol(result, 'class', 'Worker');
  const methods = result.observations.filter(item => item.kind === 'method' && item.name === 'Run');

  assert.equal(result.coverage?.status, 'complete');
  assert.ok(symbol(result, 'namespace', 'Demo.Core'));
  assert.ok(symbol(result, 'interface', 'IService'));
  assert.ok(worker);
  assert.ok(symbol(result, 'field', 'count'));
  assert.ok(symbol(result, 'field', 'retries'));
  assert.ok(symbol(result, 'property', 'Name'));
  assert.ok(symbol(result, 'constructor', 'Worker'));
  assert.equal(methods.length, 3, 'interface declaration plus two distinct overloads are retained');
  assert.equal(new Set(methods.map(item => item.id)).size, 3);
  assert.ok(result.resolutions.some(edge => edge.from === worker!.id && edge.to === symbol(result, 'property', 'Name')?.id && edge.kind === 'contains'));
  assert.deepEqual(
    result.observations.map(item => item.id).sort(),
    moved.observations.map(item => item.id).sort(),
    'line movement must not change structural identities',
  );
});

test('Java analysis preserves package, nested type, members, and overload identities', () => {
  const result = analyze('src/main/java/demo/Worker.java', `package demo.core;
public final class Worker {
  private int count;
  public Worker(int count) { this.count = count; }
  public void run() { }
  public void run(String mode) { }
  interface Nested { void execute(); }
}`);
  const worker = symbol(result, 'class', 'Worker');
  const nested = symbol(result, 'interface', 'Nested');
  const methods = result.observations.filter(item => item.kind === 'method' && item.name === 'run');

  assert.equal(result.coverage?.status, 'complete');
  assert.ok(symbol(result, 'package', 'demo.core'));
  assert.ok(worker && nested);
  assert.ok(symbol(result, 'field', 'count'));
  assert.ok(symbol(result, 'constructor', 'Worker'));
  assert.equal(methods.length, 2);
  assert.equal(new Set(methods.map(item => item.id)).size, 2);
  assert.ok(result.resolutions.some(edge => edge.from === worker.id && edge.to === nested.id && edge.kind === 'contains'));
});

test('Python analysis distinguishes methods from nested and module functions', () => {
  const result = analyze('src/worker.py', `class Worker:
    def run(self) -> None:
        def normalize(value: str) -> str:
            return value.strip()
        normalize("ok")

def main() -> None:
    Worker().run()
`);
  const worker = symbol(result, 'class', 'Worker');
  const run = symbol(result, 'method', 'run');
  const normalize = symbol(result, 'function', 'normalize');
  const main = symbol(result, 'function', 'main');

  assert.equal(result.coverage?.status, 'complete');
  assert.ok(worker && run && normalize && main);
  assert.ok(result.resolutions.some(edge => edge.from === worker.id && edge.to === run.id && edge.kind === 'contains'));
  assert.ok(result.resolutions.some(edge => edge.from === run.id && edge.to === normalize.id && edge.kind === 'contains'));
});

test('repository coverage treats supported polyglot source as eligible and parser recovery as partial', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-polyglot-coverage-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await fs.writeFile(path.join(root, 'Worker.cs'), 'public class Worker { public void Run() {} }');
    await fs.writeFile(path.join(root, 'Worker.java'), 'public class Worker { public void run() {} }');
    await fs.writeFile(path.join(root, 'worker.py'), 'def run():\n    return True\n');
    await fs.writeFile(path.join(root, 'Broken.java'), 'public class Broken { public void run( }');
    await fs.writeFile(path.join(root, 'Worker.class'), 'binary placeholder');
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const graph = await buildRepositoryGraph({ project: 'PolyglotFixture', repository: root, revision, root, role: 'W' });

    assert.equal(graph.coverage?.eligibleFiles, 4);
    assert.equal(graph.coverage?.completeFiles, 3);
    assert.equal(graph.coverage?.partialFiles, 1);
    assert.equal(graph.coverage?.unsupportedFiles, 1);
    assert.equal(graph.coverage?.files.find(file => file.path === 'Broken.java')?.status, 'partial');
    assert.equal(graph.coverage?.files.find(file => file.path === 'Worker.class')?.status, 'unsupported');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
