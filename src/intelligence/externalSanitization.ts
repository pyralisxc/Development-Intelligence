/** Bounded, fail-closed privacy boundary for untrusted external technical payloads. */
export interface RedactionSummary {
  policy: 'sanitized-v1';
  redactedFields: number;
  redactedValues: number;
  truncated: number;
  inspected: number;
  potentiallySensitiveFieldsPresent: boolean;
}
export interface SanitizedExternalPayload { value: unknown; redaction: RedactionSummary }

const SECRET_KEY = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|access[_-]?key|refresh[_-]?key|session[_-]?(?:id|key|token)?|bearer|service[_-]?role|client[_-]?secret)/iu;
const PERSONAL_KEY = /(?:email|phone|personal|owner[_-]?id|account[_-]?id|user[_-]?id|device[_-]?id|ip[_-]?address|remote[_-]?addr)/iu;
// Case-insensitive substring catches camelCase provider keys; exact environment remains a safe deployment label.
const UNSAFE_CONTENT_KEY = /(?:body|headers?|payload|stack|query|params?|request|response|rows?|records?|rowValues|environmentVariables|(?:^|[_-])(?:raw|env)(?:$|[_-]))/iu;
const SECRET_VALUE = /(?:\bBearer\s+\S+|\b(?:sk[-_](?:live|test|proj)[-_]|sb_secret_|eyJ[A-Za-z0-9_-]{15})[A-Za-z0-9._~+/-]{8,}|\b(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+)/giu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const URI = /https?:\/\/[^\s"'<>{}]+/giu;
const MAX_DEPTH = 8;
const MAX_ITEMS = 5000;
const MAX_ARRAY = 150;
const MAX_FIELDS = 125;
const MAX_TEXT = 1024;
const REDACTED = '[redacted]';

export function publicTechnicalEndpoint(value: string): string {
  try { return new URL(value).origin; } catch { return '[unavailable]'; }
}

export function sanitizeExternalPayload(input: unknown): SanitizedExternalPayload {
  const summary: RedactionSummary = {
    policy: 'sanitized-v1', redactedFields: 0, redactedValues: 0,
    truncated: 0, inspected: 0, potentiallySensitiveFieldsPresent: false,
  };
  const seen = new WeakSet<object>();
  const redact = (classification: 'field' | 'value') => {
    if (classification === 'field') summary.redactedFields += 1;
    else summary.redactedValues += 1;
    summary.potentiallySensitiveFieldsPresent = true;
    return REDACTED;
  };
  const scrubText = (str: string): string => {
    let value = str.replace(URI, match => {
      try {
        const u = new URL(match);
        if (u.search || u.hash || u.username || u.password) {
          summary.redactedValues += 1;
          summary.potentiallySensitiveFieldsPresent = true;
          return u.origin + u.pathname + '[query-redacted]';
        }
      } catch { return redact('value'); }
      return match;
    });
    value = value.replace(SECRET_VALUE, () => redact('value'));
    value = value.replace(EMAIL, () => redact('value'));
    value = value.replace(IPV4, () => redact('value'));
    if (value.length > MAX_TEXT) { summary.truncated += 1; return value.slice(0, MAX_TEXT) + '[truncated]'; }
    return value;
  };
  const visit = (item: unknown, depth: number): unknown => {
    summary.inspected += 1;
    if (summary.inspected > MAX_ITEMS || depth > MAX_DEPTH) {
      summary.truncated += 1; return '[truncated]';
    }
    if (typeof item === 'string') return scrubText(item);
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (typeof item !== 'object') return '[unsupported]';
    if (seen.has(item)) { summary.truncated += 1; return '[circular]'; }
    seen.add(item);
    if (Array.isArray(item)) {
      const result = item.slice(0, MAX_ARRAY).map(value => visit(value, depth + 1));
      if (item.length > MAX_ARRAY) { summary.truncated += 1; result.push('[truncated]'); }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    const entries = Object.entries(item as Record<string, unknown>);
    for (const [key, value] of entries.slice(0, MAX_FIELDS)) {
      // A property name can itself contain secrets or identifiers.
      if (key.length > 160 || SECRET_VALUE.test(key)) {
        SECRET_VALUE.lastIndex = 0;
        summary.redactedFields += 1; summary.potentiallySensitiveFieldsPresent = true;
        continue;
      }
      SECRET_VALUE.lastIndex = 0;
      if (SECRET_KEY.test(key) || PERSONAL_KEY.test(key) || UNSAFE_CONTENT_KEY.test(key)) {
        result[key] = redact('field');
      } else {
        result[key] = visit(value, depth + 1);
      }
    }
    if (entries.length > MAX_FIELDS) { summary.truncated += 1; result._omittedFields = entries.length - MAX_FIELDS; }
    return result;
  };
  return { value: visit(input, 0), redaction: summary };
}
