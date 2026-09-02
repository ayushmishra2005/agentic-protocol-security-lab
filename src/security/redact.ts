/**
 * Secret redaction (Constitution Article V).
 *
 * Applied to captured process output before that output is persisted, logged,
 * or returned to any caller. Redaction is deliberately over-eager: a false
 * positive costs a little readability, a false negative leaks a credential.
 */

export const REDACTED = '[REDACTED]';

interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Replacement preserving any structural prefix captured in group 1. */
  readonly replace: (match: string, ...groups: string[]) => string;
}

const keepPrefix = (_match: string, ...groups: string[]): string => `${groups[0] ?? ''}${REDACTED}`;

const RULES: readonly RedactionRule[] = [
  {
    name: 'anthropic-api-key',
    pattern: /sk-ant-[A-Za-z0-9._-]+/g,
    replace: () => REDACTED,
  },
  {
    name: 'openai-style-key',
    pattern: /\bsk-[A-Za-z0-9]{16,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    replace: () => REDACTED,
  },
  {
    name: 'bearer-token',
    pattern: /\b(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
    replace: keepPrefix,
  },
  {
    name: 'assigned-secret',
    pattern:
      /\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    replace: keepPrefix,
  },
];

/**
 * Field names whose value is a credential regardless of how the value looks.
 *
 * The rules above are line-oriented: they recognise `TOKEN=abc` because the
 * name and the value sit in one string. In structured data the name and the
 * value are separate strings, so `{"password": "hunter2"}` matches nothing —
 * `hunter2` on its own is not credential-shaped. Callers persisting structured
 * data use this to redact by field name instead.
 */
const SECRET_KEY_PATTERN =
  /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|PRIVATE[_-]?KEY)/i;

/** True when a field of this name should have its value redacted wholesale. */
export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** Redact credential-shaped substrings. Returns the input unchanged when clean. */
export function redact(input: string): string {
  if (input.length === 0) return input;
  let output = input;
  for (const rule of RULES) {
    output = output.replace(rule.pattern, rule.replace);
  }
  return output;
}

/** True when redaction would change the input. Useful for assertions and tests. */
export function containsSecret(input: string): boolean {
  return redact(input) !== input;
}
