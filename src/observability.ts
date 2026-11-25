import { hasProjectAccess, projectAccessScopeKey } from './config/projectAccess.js';
import { randomBytes } from 'node:crypto';

/** Ephemeral process identity for comparing observations, not an authority ID. */
export const runtimeInstanceId = randomBytes(16).toString('hex');

export interface ToolExecutionTiming {
  project: string;
  tool: string;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
}

const lastToolByProject = new Map<string, ToolExecutionTiming>();

export function recordToolExecution(timing: ToolExecutionTiming): void {
  lastToolByProject.set(`${projectAccessScopeKey()}:${timing.project}`, { ...timing });
}

export function toolExecutionDiagnostics(project: string): ToolExecutionTiming | null {
  const timing = lastToolByProject.get(`${projectAccessScopeKey()}:${project}`);
  return timing ? { ...timing } : null;
}

export function clearToolExecutionDiagnostics(project?: string): void {
  if (project) lastToolByProject.delete(`${projectAccessScopeKey()}:${project}`);
  else if (hasProjectAccess()) {
    for (const key of lastToolByProject.keys()) if (key.startsWith(`${projectAccessScopeKey()}:`)) lastToolByProject.delete(key);
  } else lastToolByProject.clear();
}
