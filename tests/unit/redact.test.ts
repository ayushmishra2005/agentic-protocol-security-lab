// Every credential below is fabricated for this test. No real environment
// value is read here or anywhere else in the suite.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containsSecret, redact, REDACTED } from '../../src/security/redact.js';

describe('redact', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['an Anthropic-style key', 'key is sk-ant-api03-AAAABBBBCCCCDDDD here'],
    ['an sk-prefixed key', 'token sk-ABCDEFGHIJKLMNOPQRSTUVWX done'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a GitHub token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
    ['an assigned API key', 'ANTHROPIC_API_KEY=totally-not-real-value'],
    ['a quoted assigned secret', 'my_secret: "hunter2-not-real"'],
    ['a bearer token', 'Authorization: Bearer abcdefghijklmnop'],
  ];

  for (const [label, input] of cases) {
    it(`redacts ${label}`, () => {
      const output = redact(input);
      assert.ok(output.includes(REDACTED), `expected redaction in: ${output}`);
      assert.equal(containsSecret(input), true);
    });
  }

  it('redacts a private key block in full', () => {
    const input = [
      'preamble',
      '-----BEGIN RSA PRIVATE KEY-----',
      'AAAAFAKEKEYMATERIALFAKEKEYMATERIAL',
      '-----END RSA PRIVATE KEY-----',
      'postamble',
    ].join('\n');
    const output = redact(input);
    assert.ok(!output.includes('FAKEKEYMATERIAL'));
    assert.ok(output.includes('preamble'));
    assert.ok(output.includes('postamble'));
  });

  it('keeps the variable name so output stays diagnosable', () => {
    assert.match(redact('ANTHROPIC_API_KEY=abc123def456'), /ANTHROPIC_API_KEY=/);
  });

  it('leaves ordinary output untouched', () => {
    const clean = 'Compiling main to a dar file. Created .daml/dist/main-0.0.1.dar';
    assert.equal(redact(clean), clean);
    assert.equal(containsSecret(clean), false);
  });

  it('handles an empty string', () => {
    assert.equal(redact(''), '');
  });
});
