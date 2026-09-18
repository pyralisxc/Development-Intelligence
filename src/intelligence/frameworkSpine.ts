import type { GraphEdge, GraphNode } from '../types.js';
import { resolution } from './model.js';

function valueRecord(node: GraphNode): Record<string, unknown> | null {
  return node.value && typeof node.value === 'object' && !Array.isArray(node.value) ? node.value as Record<string, unknown> : null;
}

function routeSegments(value: string): string[] {
  return value.split(/[?#]/u, 1)[0]!.split('/').filter(Boolean).map(segment => {
    if (/^\[+\.{0,3}[^\]]+\]+$/u.test(segment)) return '*';
    if (/^\$\{[^}]+\}$/u.test(segment)) return '*';
    return segment;
  });
}

function routeMatches(callUrl: string, apiRoute: string): boolean {
  const left = routeSegments(callUrl);
  const right = routeSegments(apiRoute);
  if (left.length !== right.length) return false;
  return left.every((segment, index) => segment === '*' || right[index] === '*' || segment === right[index]);
}

export function resolveFrameworkSpine(nodes: GraphNode[], existing: GraphEdge[]): GraphEdge[] {
  const output = [...existing];
  const seen = new Set(existing.map(edge => edge.id));
  const add = (edge: GraphEdge) => { if (!seen.has(edge.id)) { seen.add(edge.id); output.push(edge); } };
  const apis = nodes.filter(node => node.layer === 'semantic' && node.kind === 'api' && node.name);

  for (const api of apis) {
    const handlers = nodes.filter(node => node.sourceId === api.sourceId && ['function', 'method'].includes(node.kind) && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/u.test(node.name ?? ''));
    for (const handler of handlers) add(resolution({
      from: api.id,
      to: handler.id,
      kind: 'handles-method',
      strategy: 'framework-route',
      confidence: 1,
      status: 'resolved',
      evidence: [api.locator, handler.locator],
      layer: 'representation',
      checkpoint: false,
    }));
  }

  for (const call of nodes.filter(node => node.kind === 'http-call')) {
    const value = valueRecord(call);
    const url = typeof value?.url === 'string' ? value.url : null;
    const method = typeof value?.method === 'string' ? value.method.toUpperCase() : 'GET';
    if (!url || !url.startsWith('/')) continue;
    const candidates = apis.filter(api => api.name && routeMatches(url, api.name));
    if (candidates.length === 1) {
      const api = candidates[0]!;
      add(resolution({ from: call.id, to: api.id, kind: 'resolves_to', strategy: 'framework-route', confidence: 1, status: 'resolved', evidence: [call.locator, api.locator], layer: 'representation', checkpoint: false }));
      const handlers = nodes.filter(node => node.sourceId === api.sourceId && ['function', 'method'].includes(node.kind) && node.name === method);
      if (handlers.length === 1) add(resolution({ from: call.id, to: handlers[0]!.id, kind: 'handled_by', strategy: 'framework-route-method', confidence: 1, status: 'resolved', evidence: [call.locator, handlers[0]!.locator], layer: 'representation', checkpoint: false }));
      else if (handlers.length !== 1) add(resolution({ from: call.id, to: null, kind: 'handled_by', strategy: 'framework-route-method', confidence: null, status: 'unresolved', evidence: [call.locator, handlers.length ? `${method} handler is ambiguous for ${api.name}` : `${method} handler is unavailable for ${api.name}`], layer: 'representation', checkpoint: false }));
    } else if (candidates.length > 1) add(resolution({ from: call.id, to: null, kind: 'resolves_to', strategy: 'framework-route', confidence: null, status: 'unresolved', evidence: [call.locator, `HTTP target ${url} matches ${candidates.length} APIs`], layer: 'representation', checkpoint: false }));
  }

  return output;
}
