import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTypeScript } from '../src/intelligence/analyzers/typescript.js';
import { analyzeCss } from '../src/intelligence/analyzers/css.js';
import { resolveEvidenceSpine } from '../src/intelligence/spine.js';

const source = (id: string) => ({ id: `repo:${id}`, kind: 'repository-file', locator: id, revision: 'test', observedAt: new Date(0).toISOString(), available: true });

test('TypeScript behavior observations expose dynamic transport, state, router navigation, RPC, and component callback bindings', () => {
  const child = analyzeTypeScript({
    source: source('Child.tsx'),
    locatorBase: 'Child.tsx',
    text: `
export function Child({ onToggle }: { onToggle: (id: string) => void }) {
  return <button onClick={onToggle}>Heart</button>;
}
`,
  });
  const parent = analyzeTypeScript({
    source: source('Parent.tsx'),
    locatorBase: 'Parent.tsx',
    text: `
export function Parent({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toggleHeart = async (itemId: string) => {
    setBusy(true);
    await fetch(\`/api/items/\${itemId}/heart\`, { method: 'POST' });
    await database.rpc('cardforge_set_pipeline_heart', { p_lineage_id: itemId });
    router.replace(\`/items/\${itemId}\`);
  };
  return <Child onToggle={(itemId) => void toggleHeart(itemId)} />;
}
`,
  });
  const observations = [...child.observations, ...parent.observations];
  const edges = resolveEvidenceSpine(observations, [...child.resolutions, ...parent.resolutions]);
  const kinds = new Set(observations.map(item => item.kind));
  for (const kind of ['component-prop-handler', 'component-prop-binding', 'state-binding', 'state-write', 'http-call', 'rpc-call', 'navigation-call']) assert.ok(kinds.has(kind), `missing ${kind}`);
  const http = observations.find(item => item.kind === 'http-call');
  assert.deepEqual(http?.value, { method: 'POST', url: '/api/items/${itemId}/heart', dynamic: true });
  assert.ok(edges.some(edge => edge.kind === 'bound_by' && edge.status === 'resolved'), 'component prop handler should connect to its concrete binding');
  assert.ok(edges.some(edge => edge.kind === 'binds_to' && edge.status === 'resolved'), 'component prop binding should connect to the concrete callback');
});


test('static JSX class references resolve to exact observed CSS selectors', () => {
  const component = analyzeTypeScript({
    source: source('Studio.tsx'),
    locatorBase: 'Studio.tsx',
    text: `
export function Studio() {
  return <div className="cardforge-studio-workspace flex min-h-0">Studio</div>;
}
`,
  });
  const css = analyzeCss({
    source: source('studio.css'),
    locatorBase: 'studio.css',
    text: `
.cardforge-studio-workspace { overflow: hidden; display: flex; }
.cardforge-studio-workspace .panel { overflow-y: auto; }
.unrelated { display: block; }
`,
  });
  const observations = [...component.observations, ...css.observations];
  const edges = resolveEvidenceSpine(observations, [...component.resolutions, ...css.resolutions]);
  const classRef = observations.find(item => item.kind === 'css-class-reference');
  assert.deepEqual(classRef?.value, { tag: 'div', classes: ['cardforge-studio-workspace', 'flex', 'min-h-0'] });
  const matchingSelectors = observations.filter(item => item.kind === 'css-selector' && String(item.name).includes('.cardforge-studio-workspace'));
  assert.equal(matchingSelectors.length, 2);
  assert.ok(matchingSelectors.every(selector => edges.some(edge => edge.from === classRef?.id && edge.to === selector.id && edge.kind === 'styled_by' && edge.status === 'resolved')));
  const unrelated = observations.find(item => item.kind === 'css-selector' && item.name === '.unrelated');
  assert.ok(unrelated);
  assert.equal(edges.some(edge => edge.from === classRef?.id && edge.to === unrelated?.id && edge.kind === 'styled_by'), false);
});
