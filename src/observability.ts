export interface ToolExecutionTiming {
  project: string;
  tool: string;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
}

const lastToolByProject = new Map<string, ToolExecutionTiming>();

export function recordToolExecution(timing: ToolExecutionTiming): void {
  lastToolByProject.set(timing.project, { ...timing });
}

export function toolExecutionDiagnostics(project: string): ToolExecutionTiming | null {
  const timing = lastToolByProject.get(project);
  return timing ? { ...timing } : null;
}

export function clearToolExecutionDiagnostics(project?: string): void {
  if (project) lastToolByProject.delete(project);
  else lastToolByProject.clear();
}
