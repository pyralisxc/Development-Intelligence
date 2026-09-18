import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSql } from '../src/intelligence/analyzers/sql.js';
import { resolveEvidenceSpine } from '../src/intelligence/spine.js';
import { resolveFrameworkSpine } from '../src/intelligence/frameworkSpine.js';
import type { GraphNode } from '../src/types.js';

const source = { id: 'repo:migrations/001.sql', kind: 'repository-file', locator: 'migrations/001.sql', revision: 'test', observedAt: new Date(0).toISOString(), available: true };

test('SQL evidence resolves RPC routines and durable table effects conservatively', () => {
  const sql = analyzeSql({ source, locatorBase: 'migrations/001.sql', text: `
create table public.cardforge_pipeline_asset_hearts(lineage_id uuid primary key);
create or replace function public.cardforge_set_pipeline_heart(p_lineage_id uuid)
returns void language plpgsql as $$
begin
  update public.cardforge_pipeline_asset_hearts set lineage_id = p_lineage_id where lineage_id = p_lineage_id;
end;
$$;
` });
  const rpc: GraphNode = { id: 'rpc', sourceId: 'repo:client.ts', kind: 'rpc-call', locator: 'client.ts:1:rpc', name: 'cardforge_set_pipeline_heart', field: 'rpc', value: { routine: 'cardforge_set_pipeline_heart' }, raw: '', layer: 'representation', checkpoint: false };
  const nodes = [rpc, ...sql.observations];
  const edges = resolveEvidenceSpine(nodes, sql.resolutions);
  const routine = sql.observations.find(item => item.kind === 'sql-function');
  const table = sql.observations.find(item => item.kind === 'sql-table');
  assert.ok(routine && table);
  assert.ok(edges.some(edge => edge.from === rpc.id && edge.to === routine.id && edge.status === 'resolved'));
  const tableReference = sql.observations.find(item => item.kind === 'sql-reference' && (item.value as any).operation === 'writes');
  assert.ok(tableReference);
  assert.ok(edges.some(edge => edge.from === tableReference!.id && edge.to === table.id && edge.status === 'resolved'));
});

test('SQL structural identities survive comment and line movement', () => {
  const sql = `
create table public.items(id uuid primary key);
create or replace function public.touch_item(p_id uuid)
returns void language sql as $$ update public.items set id = p_id where id = p_id $$;
create index items_id_idx on public.items(id);
`;
  const baseline = analyzeSql({ source, locatorBase: 'migrations/001.sql', text: sql });
  const moved = analyzeSql({ source, locatorBase: 'migrations/001.sql', text: `-- harmless movement\n\n${sql}` });
  const structuralIds = (result: ReturnType<typeof analyzeSql>) => result.observations
    .filter(item => item.layer === 'structural')
    .map(item => item.id)
    .sort();
  assert.deepEqual(structuralIds(moved), structuralIds(baseline));
});

test('framework transport resolution joins parameterized HTTP calls to API and method handler', () => {
  const nodes: GraphNode[] = [
    { id: 'api:/api/items/[id]/heart', sourceId: 'repo:src/app/api/items/[id]/heart/route.ts', kind: 'api', locator: 'src/app/api/items/[id]/heart/route.ts', name: '/api/items/[id]/heart', value: { route: '/api/items/[id]/heart' }, raw: '', layer: 'semantic', checkpoint: true },
    { id: 'post', sourceId: 'repo:src/app/api/items/[id]/heart/route.ts', kind: 'function', locator: 'src/app/api/items/[id]/heart/route.ts:3', name: 'POST', value: 'POST', raw: '', layer: 'structural', checkpoint: false },
    { id: 'call', sourceId: 'repo:src/ui.tsx', kind: 'http-call', locator: 'src/ui.tsx:5:fetch', name: 'POST /api/items/${itemId}/heart', value: { method: 'POST', url: '/api/items/${itemId}/heart', dynamic: true }, raw: '', layer: 'representation', checkpoint: false },
  ];
  const edges = resolveFrameworkSpine(nodes, []);
  assert.ok(edges.some(edge => edge.from === 'call' && edge.to === 'api:/api/items/[id]/heart' && edge.kind === 'resolves_to'));
  assert.ok(edges.some(edge => edge.from === 'call' && edge.to === 'post' && edge.kind === 'handled_by'));
});
