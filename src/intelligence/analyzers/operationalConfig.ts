import path from 'node:path';
import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import type { Observation } from '../../types.js';
import { observation } from '../model.js';

const SENSITIVE_KEY = /(^|[._-])(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|access[-_]?token|refresh[-_]?token)($|[._-])/i;
const SENSITIVE_TEXT = /(?:secrets?\.|password|passwd|secret(?:[_-]?key)?|api[-_]?(?:key|token)|authorization|credential|private[-_]?key|access[-_]?token|refresh[-_]?token|(?:^|[^A-Za-z0-9])token(?:[^A-Za-z0-9]|$))/i;
const ENV_EXAMPLE = /^\.env\.(?:example|sample|template|defaults?)$/i;

function baseName(locator: string): string {
  return path.posix.basename(locator.replace(/\\/g, '/'));
}

export function isOperationalConfigPath(locator: string): boolean {
  const normalized = locator.replace(/\\/g, '/');
  const base = baseName(normalized);
  const ext = path.posix.extname(base).toLowerCase();
  return ext === '.yml'
    || ext === '.yaml'
    || base === '.gitignore'
    || base === '.dockerignore'
    || ENV_EXAMPLE.test(base)
    || base === 'Dockerfile'
    || base.startsWith('Dockerfile.');
}

function safeText(value: string, field = ''): string {
  const trimmed = value.trim().slice(0, 300);
  return SENSITIVE_KEY.test(field) || SENSITIVE_TEXT.test(trimmed) ? '<redacted>' : trimmed;
}

function opObservation(
  context: AnalyzeContext,
  input: { kind: string; line: number; name?: string; field?: string; value: unknown; raw?: string },
): Observation {
  return observation({
    sourceId: context.source.id,
    kind: input.kind,
    locator: `${context.locatorBase}:${input.line}`,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.field === undefined ? {} : { field: input.field }),
    value: input.value,
    raw: input.raw ?? (typeof input.value === 'string' ? input.value : JSON.stringify(input.value)),
    tags: ['operational'],
    layer: 'structural',
    checkpoint: false,
  });
}

function yamlPath(stack: Array<{ indent: number; key: string }>, key?: string): string {
  return [...stack.map(item => item.key), ...(key ? [key] : [])].join('.');
}

function analyzeYaml(context: AnalyzeContext): AnalyzeResult {
  const observations: Observation[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  const lines = context.text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indentText = /^\s*/u.exec(rawLine)?.[0] ?? '';
    const indent = indentText.replace(/\t/gu, '  ').length;
    const trimmed = rawLine.trim();
    const isList = trimmed.startsWith('- ');
    const content = isList ? trimmed.slice(2).trim() : trimmed;
    const pair = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/u.exec(content);

    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();

    if (!pair) {
      const parent = yamlPath(stack);
      if (isList && parent === 'on') {
        observations.push(opObservation(context, {
          kind: 'workflow-trigger',
          line: index + 1,
          name: safeText(content),
          field: 'on',
          value: { event: safeText(content) },
        }));
      }
      continue;
    }

    const key = pair[1]!;
    const scalar = (pair[2] ?? '').trim();
    const parent = yamlPath(stack);
    const fullPath = yamlPath(stack, key);
    observations.push(opObservation(context, {
      kind: 'config-key',
      line: index + 1,
      name: key,
      field: fullPath,
      value: { path: fullPath },
    }));

    if (parent === 'jobs') {
      observations.push(opObservation(context, {
        kind: 'workflow-job',
        line: index + 1,
        name: key,
        field: fullPath,
        value: { job: key },
      }));
    }
    if (parent === 'on') {
      observations.push(opObservation(context, {
        kind: 'workflow-trigger',
        line: index + 1,
        name: key,
        field: fullPath,
        value: { event: key },
      }));
    }
    if (key === 'on' && scalar.startsWith('[') && scalar.endsWith(']')) {
      for (const event of scalar.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean)) {
        observations.push(opObservation(context, {
          kind: 'workflow-trigger',
          line: index + 1,
          name: event,
          field: fullPath,
          value: { event },
        }));
      }
    }
    if (key === 'uses' && scalar) {
      observations.push(opObservation(context, {
        kind: 'action-reference',
        line: index + 1,
        name: safeText(scalar, fullPath),
        field: fullPath,
        value: { uses: safeText(scalar, fullPath) },
        raw: safeText(scalar, fullPath),
      }));
    }
    if (key === 'run' && scalar) {
      const command = safeText(scalar, fullPath);
      observations.push(opObservation(context, {
        kind: 'script-command',
        line: index + 1,
        name: command === '<redacted>' ? 'run' : command,
        field: fullPath,
        value: { command },
        raw: command,
      }));
    }
    if (parent.endsWith('inputs')) {
      observations.push(opObservation(context, {
        kind: 'action-input',
        line: index + 1,
        name: key,
        field: fullPath,
        value: { input: key },
      }));
    }
    if (parent.endsWith('outputs')) {
      observations.push(opObservation(context, {
        kind: 'action-output',
        line: index + 1,
        name: key,
        field: fullPath,
        value: { output: key },
      }));
    }
    if (isList && stack.some(item => item.key === 'steps')) {
      observations.push(opObservation(context, {
        kind: 'workflow-step',
        line: index + 1,
        name: key === 'name' && scalar ? safeText(scalar, fullPath) : key,
        field: fullPath,
        value: { stepKey: key },
      }));
    }

    if (!scalar || scalar === '|' || scalar === '>') stack.push({ indent, key });
  }
  return { observations, resolutions: [] };
}

function analyzeEnvironmentExample(context: AnalyzeContext): AnalyzeResult {
  const observations: Observation[] = [];
  const lines = context.text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(trimmed);
    if (!match) continue;
    const name = match[1]!;
    observations.push(opObservation(context, {
      kind: 'env-variable',
      line: index + 1,
      name,
      field: name,
      value: { name, value: '<declared>' },
      raw: `${name}=<declared>`,
    }));
  }
  return { observations, resolutions: [] };
}

function analyzeIgnoreFile(context: AnalyzeContext): AnalyzeResult {
  const observations: Observation[] = [];
  const lines = context.text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    observations.push(opObservation(context, {
      kind: 'ignore-pattern',
      line: index + 1,
      name: trimmed,
      field: 'pattern',
      value: { pattern: trimmed, negated: trimmed.startsWith('!') },
    }));
  }
  return { observations, resolutions: [] };
}

function analyzeDockerfile(context: AnalyzeContext): AnalyzeResult {
  const observations: Observation[] = [];
  const lines = context.text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z]+)\s+(.+)$/u.exec(trimmed);
    if (!match) continue;
    const instruction = match[1]!.toUpperCase();
    const operand = match[2]!.trim();

    if (instruction === 'FROM') {
      const alias = /\s+AS\s+([^\s]+)$/iu.exec(operand)?.[1] ?? null;
      const image = operand.replace(/\s+AS\s+[^\s]+$/iu, '').trim();
      observations.push(opObservation(context, {
        kind: 'docker-stage',
        line: index + 1,
        name: alias ?? image,
        field: instruction,
        value: { image, alias },
      }));
      continue;
    }

    if (instruction === 'ARG' || instruction === 'ENV') {
      const name = /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(operand)?.[1] ?? instruction.toLowerCase();
      observations.push(opObservation(context, {
        kind: 'docker-env',
        line: index + 1,
        name,
        field: name,
        value: { instruction, name, value: '<declared>' },
        raw: `${instruction} ${name}=<declared>`,
      }));
      continue;
    }

    const safeOperand = safeText(operand, instruction);
    const kind = instruction === 'RUN'
      ? 'docker-run'
      : instruction === 'COPY' || instruction === 'ADD'
        ? 'docker-copy'
        : instruction === 'CMD' || instruction === 'ENTRYPOINT'
          ? 'docker-entrypoint'
          : 'docker-instruction';
    observations.push(opObservation(context, {
      kind,
      line: index + 1,
      name: instruction,
      field: instruction,
      value: { instruction, operand: safeOperand },
      raw: safeOperand,
    }));
  }
  return { observations, resolutions: [] };
}

export function analyzeOperationalConfig(context: AnalyzeContext): AnalyzeResult {
  const base = baseName(context.locatorBase);
  const ext = path.posix.extname(base).toLowerCase();
  if (ext === '.yml' || ext === '.yaml') return analyzeYaml(context);
  if (ENV_EXAMPLE.test(base)) return analyzeEnvironmentExample(context);
  if (base === '.gitignore' || base === '.dockerignore') return analyzeIgnoreFile(context);
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) return analyzeDockerfile(context);
  return { observations: [], resolutions: [] };
}
