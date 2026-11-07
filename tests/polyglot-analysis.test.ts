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

test('Python module-level assignment identity is exact and does not include conditional/local names', () => {
  const source = `BROKER_PORT = int("8767")
BROWSER_POOL_DIR: str = "/tmp/pool"
NO_VALUE: int
BROKEN_CHAIN = OTHER = 1
DESTRUCTURED, OTHER_NAME = (1, 2)
def local():
    LOCAL_ONLY = 1
class Worker:
    CLASS_ONLY = 1
if True:
    CONDITIONAL = 1
`;
  const result = analyze('ax_browser_broker/config.py', source);
  const moved = analyze('ax_browser_broker/config.py', '# doc\n\n' + source);
  assert.equal(result.coverage?.status, 'complete');
  for (const name of ['BROKER_PORT', 'BROWSER_POOL_DIR']) {
    const item = symbol(result, 'declaration', name);
    assert.ok(item, `module-level ${name} should have a native declaration identity`);
    assert.equal((item!.value as any).language, 'python');
    assert.equal((item!.value as any).qualifiedName, name);
    assert.equal(item!.id, symbol(moved, 'declaration', name)?.id, 'line movement must not change identity');
  }
  for (const name of ['NO_VALUE', 'BROKEN_CHAIN', 'OTHER', 'DESTRUCTURED', 'OTHER_NAME', 'LOCAL_ONLY', 'CLASS_ONLY', 'CONDITIONAL']) {
    assert.equal(symbol(result, 'declaration', name), undefined, `${name} is not a directly guaranteed module binding`);
  }
});

test('Python local imports resolve exact module assignments and retain ambiguous/conditional names as unknown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-python-module-binding-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await fs.mkdir(path.join(root, 'demo'), { recursive: true });
    await fs.writeFile(path.join(root, 'demo', '__init__.py'), '');
    await fs.writeFile(path.join(root, 'demo', 'config.py'), `BROKER_PORT = 8767
BROWSER_POOL_DIR: str = "/tmp/pool"
DUPLICATE = 1
DUPLICATE = 2
ANNOTATION_ONLY: int
def hidden():
    LOCAL_ONLY = 1
class Holder:
    CLASS_ONLY = 1
if True:
    CONDITIONAL = 1
`);
    await fs.writeFile(path.join(root, 'demo', 'consumer.py'),
      'from .config import BROKER_PORT, BROWSER_POOL_DIR, DUPLICATE, ANNOTATION_ONLY, LOCAL_ONLY, CLASS_ONLY, CONDITIONAL\n');
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const graph = await buildRepositoryGraph({ project: 'PythonModuleBindingFixture', repository: root, revision, root, role: 'W' });
    assert.equal(graph.coverage?.completeFiles, 3);

    for (const name of ['BROKER_PORT', 'BROWSER_POOL_DIR']) {
      const binding = graph.nodes.find(node => node.kind === 'import-binding' && node.name === name
        && node.sourceId === 'repo:demo/consumer.py');
      const target = graph.nodes.find(node => node.kind === 'declaration' && node.name === name
        && node.sourceId === 'repo:demo/config.py');
      assert.ok(binding && target, `${name} must be in the exact tracked source`);
      assert.ok(graph.edges.some(edge => edge.from === binding.id && edge.to === target.id
        && edge.kind === 'resolves_to' && edge.status === 'resolved'), `${name} must resolve through native source evidence`);
      assert.ok(graph.edges.some(edge => edge.from === 'file:demo/consumer.py'
        && edge.to === 'file:demo/config.py' && edge.kind === 'imports-file' && edge.status === 'resolved'));
    }
    for (const name of ['DUPLICATE', 'ANNOTATION_ONLY', 'LOCAL_ONLY', 'CLASS_ONLY', 'CONDITIONAL']) {
      const binding = graph.nodes.find(node => node.kind === 'import-binding' && node.name === name
        && node.sourceId === 'repo:demo/consumer.py');
      assert.ok(binding, name);
      assert.equal(graph.edges.some(edge => edge.from === binding.id && edge.kind === 'resolves_to'
        && edge.status === 'resolved'), false, name + ' must not gain source-proven import certainty');
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Go analysis preserves package, type, function, method, import, and containment identities', () => {
  const result = analyze('internal/web/router.go', `package web

import (
  "net/http"
  jsoncodec "example.com/project/internal/json"
)

type Router struct {
  engine *http.ServeMux
}

type Handler interface {
  Handle()
}

type Mode string

func NewRouter() *Router { return &Router{} }
func (r *Router) Run(addr string) error { return nil }
`);

  const pkg = symbol(result, 'package', 'web');
  const router = symbol(result, 'struct', 'Router');
  const handler = symbol(result, 'interface', 'Handler');
  const mode = symbol(result, 'type', 'Mode');
  const factory = symbol(result, 'function', 'NewRouter');
  const run = symbol(result, 'method', 'Run');
  const jsonImport = result.observations.find(item => item.kind === 'import-binding' && item.name === 'jsoncodec');

  assert.equal(result.coverage?.status, 'complete');
  assert.ok(pkg && router && handler && mode && factory && run && jsonImport);
  assert.equal((run.value as any).receiverType, 'Router');
  assert.equal((jsonImport.value as any).module, 'example.com/project/internal/json');
  assert.ok(result.resolutions.some(edge => edge.from === pkg.id && edge.to === router.id && edge.kind === 'contains'));
  assert.ok(result.resolutions.some(edge => edge.from === pkg.id && edge.to === run.id && edge.kind === 'contains'));
});

test('Rust analysis preserves modules, types, functions, receiver methods, and use bindings', () => {
  const result = analyze('crates/app/src/router.rs', `
use crate::state::AppState;
use std::sync::Arc;

pub mod routes;

pub struct Router {
    state: Arc<AppState>,
}

pub enum Mode { Local, Remote }
pub trait Handler { fn handle(&self); }
pub type SharedState = Arc<AppState>;

impl Router {
    pub fn new(state: Arc<AppState>) -> Self { Self { state } }
    pub async fn serve(&self) {}
}

pub fn build() -> Router { panic!("fixture") }
`);

  const router = symbol(result, 'struct', 'Router');
  const mode = symbol(result, 'enum', 'Mode');
  const handler = symbol(result, 'trait', 'Handler');
  const alias = symbol(result, 'type', 'SharedState');
  const build = symbol(result, 'function', 'build');
  const serve = symbol(result, 'method', 'serve');
  const appState = result.observations.find(item => item.kind === 'import-binding' && item.name === 'AppState');
  const routes = symbol(result, 'module', 'routes');

  assert.equal(result.coverage?.status, 'complete');
  assert.ok(router && mode && handler && alias && build && serve && appState && routes);
  assert.equal((serve.value as any).ownerType, 'Router');
  assert.equal((appState.value as any).module, 'crate::state');
  assert.equal((appState.value as any).imported, 'AppState');
});

test('repository coverage treats supported polyglot source as eligible and parser recovery as partial', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-polyglot-coverage-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await fs.writeFile(path.join(root, 'Worker.cs'), 'public class Worker { public void Run() {} }');
    await fs.writeFile(path.join(root, 'Worker.java'), 'public class Worker { public void run() {} }');
    await fs.writeFile(path.join(root, 'worker.py'), 'def run():\n    return True\n');
    await fs.writeFile(path.join(root, 'worker.go'), 'package fixture\nfunc Run() bool { return true }\n');
    await fs.writeFile(path.join(root, 'worker.rs'), 'pub struct Worker;\npub fn run() -> bool { true }\n');
    await fs.writeFile(path.join(root, 'Broken.java'), 'public class Broken { public void run( }');
    await fs.writeFile(path.join(root, 'Worker.class'), 'binary placeholder');
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const graph = await buildRepositoryGraph({ project: 'PolyglotFixture', repository: root, revision, root, role: 'W' });

    assert.equal(graph.coverage?.eligibleFiles, 6);
    assert.equal(graph.coverage?.completeFiles, 5);
    assert.equal(graph.coverage?.partialFiles, 1);
    assert.equal(graph.coverage?.unsupportedFiles, 1);
    assert.equal(graph.coverage?.files.find(file => file.path === 'Broken.java')?.status, 'partial');
    assert.equal(graph.coverage?.files.find(file => file.path === 'Worker.class')?.status, 'unsupported');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('polyglot imports resolve modules and exact local symbols without inventing external source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-polyglot-modules-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await fs.mkdir(path.join(root, 'csharp'));
    await fs.mkdir(path.join(root, 'java', 'demo', 'app'), { recursive: true });
    await fs.mkdir(path.join(root, 'java', 'demo', 'core'), { recursive: true });
    await fs.mkdir(path.join(root, 'python', 'demo'), { recursive: true });
    await fs.mkdir(path.join(root, 'project', 'core'), { recursive: true });
    await fs.mkdir(path.join(root, 'project', 'app'), { recursive: true });
    await fs.mkdir(path.join(root, 'rust', 'src', 'core'), { recursive: true });
    await fs.writeFile(path.join(root, 'csharp', 'Core.cs'), 'namespace Demo.Core; public sealed class Worker { }\n');
    await fs.writeFile(path.join(root, 'csharp', 'App.cs'), 'using Demo.Core; using WorkerAlias = Demo.Core.Worker; namespace Demo.App; public sealed class App { }\n');
    await fs.writeFile(path.join(root, 'java', 'demo', 'core', 'Worker.java'), 'package demo.core; public final class Worker { }\n');
    await fs.writeFile(path.join(root, 'java', 'demo', 'app', 'App.java'), 'package demo.app; import demo.core.Worker; import java.util.List; public final class App { }\n');
    await fs.writeFile(path.join(root, 'python', 'demo', 'services.py'), 'class Worker:\n    pass\n\ndef helper():\n    pass\n');
    await fs.writeFile(path.join(root, 'python', 'app.py'), 'from demo.services import Worker\n');
    await fs.writeFile(path.join(root, 'project', 'core', 'worker.go'), 'package core\ntype Worker struct{}\n');
    await fs.writeFile(path.join(root, 'project', 'app', 'app.go'), 'package app\nimport core "example.com/project/core"\nfunc Start() {}\n');
    await fs.writeFile(path.join(root, 'rust', 'src', 'core', 'mod.rs'), 'pub struct Worker;\n');
    await fs.writeFile(path.join(root, 'rust', 'src', 'app.rs'), 'use crate::core::Worker;\npub fn start() {}\n');
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const graph = await buildRepositoryGraph({ project: 'PolyglotModulesFixture', repository: root, revision, root, role: 'W' });

    const csharpAlias = graph.nodes.find(node => node.kind === 'import-binding' && node.sourceId === 'repo:csharp/App.cs' && node.name === 'WorkerAlias');
    const javaWorker = graph.nodes.find(node => node.kind === 'import-binding' && node.sourceId === 'repo:java/demo/app/App.java' && node.name === 'Worker');
    const pythonWorker = graph.nodes.find(node => node.kind === 'import-binding' && node.sourceId === 'repo:python/app.py' && node.name === 'Worker');
    const externalJava = graph.nodes.find(node => node.id === 'module:java:java.util');
    const goCore = graph.nodes.find(node => node.kind === 'import-binding' && node.sourceId === 'repo:project/app/app.go' && node.name === 'core');
    const rustWorker = graph.nodes.find(node => node.kind === 'import-binding' && node.sourceId === 'repo:rust/src/app.rs' && node.name === 'Worker');

    assert.ok(csharpAlias && javaWorker && pythonWorker && goCore && rustWorker);
    assert.ok(graph.nodes.some(node => node.id === 'module:csharp:Demo.Core' && node.tags?.includes('local-source')));
    assert.ok(graph.nodes.some(node => node.id === 'module:java:demo.core' && node.tags?.includes('local-source')));
    assert.ok(graph.nodes.some(node => node.id === 'module:python:demo.services' && node.tags?.includes('local-source')));
    assert.ok(externalJava?.tags?.includes('source-unavailable'));
    assert.ok(graph.edges.some(edge => edge.from === csharpAlias.id && edge.to?.includes('#class:Demo.Core.Worker') && edge.kind === 'resolves_to'));
    assert.ok(graph.edges.some(edge => edge.from === javaWorker.id && edge.to?.includes('#class:demo.core.Worker') && edge.kind === 'resolves_to'));
    assert.ok(graph.edges.some(edge => edge.from === pythonWorker.id && edge.to?.includes('#class:Worker') && edge.kind === 'resolves_to'));
    assert.ok(graph.edges.some(edge => edge.from === 'file:python/app.py' && edge.to === 'file:python/demo/services.py' && edge.kind === 'imports-file'));
    assert.ok(graph.nodes.some(node => node.id === 'module:go:project/core' && node.tags?.includes('local-source')));
    assert.ok(graph.edges.some(edge => edge.from === 'file:project/app/app.go' && edge.to === 'module:go:project/core' && edge.kind === 'imports'));
    assert.ok(graph.nodes.some(node => node.id === 'module:rust:core' && node.tags?.includes('local-source')));
    assert.ok(graph.edges.some(edge => edge.from === rustWorker.id && edge.to?.includes('#struct:Worker') && edge.kind === 'resolves_to'));
    assert.ok(graph.edges.some(edge => edge.from === 'file:rust/src/app.rs' && edge.to === 'file:rust/src/core/mod.rs' && edge.kind === 'imports-file'));

    assert.ok(!graph.edges.some(edge => edge.status === 'candidate' && (edge.from === javaWorker.id || edge.to === javaWorker.id)), 'dedicated import resolution must not be diluted by generic same-name candidates');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('C# repository binding resolves interfaces, constructors, and safe cross-file calls without guessing instance dispatch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-csharp-binding-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await fs.mkdir(path.join(root, 'Core'));
    await fs.mkdir(path.join(root, 'App'));
    await fs.writeFile(path.join(root, 'Core', 'Service.cs'), `namespace Demo.Core;
public interface IService { void Run(); }
public sealed class Service : IService {
  public Service(int seed) { }
  public static void Start() { }
  public void Run() { }
}
`);
    await fs.writeFile(path.join(root, 'App', 'Program.cs'), `using Demo.Core;
namespace Demo.App;
public sealed class Program {
  public void Execute() {
    var service = new Service(1);
    Service.Start();
    service.Run();
  }
}
`);
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const graph = await buildRepositoryGraph({ project: 'CSharpBindingFixture', repository: root, revision, root, role: 'W' });

    const service = graph.nodes.find(node => node.kind === 'class' && node.name === 'Service');
    const contract = graph.nodes.find(node => node.kind === 'interface' && node.name === 'IService');
    const constructor = graph.nodes.find(node => node.kind === 'constructor' && node.name === 'Service');
    const start = graph.nodes.find(node => node.kind === 'method' && node.name === 'Start');
    const run = graph.nodes.find(node => node.kind === 'method' && node.name === 'Run' && node.sourceId === 'repo:Core/Service.cs');
    const execute = graph.nodes.find(node => node.kind === 'method' && node.name === 'Execute');

    assert.ok(service && contract && constructor && start && run && execute);
    assert.ok(graph.edges.some(edge => edge.from === contract.id && edge.to === service.id && edge.kind === 'implemented-by' && edge.status === 'resolved'));
    assert.ok(graph.edges.some(edge => edge.from === execute.id && edge.to === constructor.id && edge.kind === 'constructs' && edge.status === 'resolved'));
    assert.ok(graph.edges.some(edge => edge.from === execute.id && edge.to === start.id && edge.kind === 'calls' && edge.status === 'resolved'));
    assert.equal(
      graph.edges.some(edge => edge.from === execute.id && edge.to === run.id && edge.kind === 'calls' && edge.status === 'resolved'),
      false,
      'instance dispatch through a local variable must not be guessed without type evidence',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
