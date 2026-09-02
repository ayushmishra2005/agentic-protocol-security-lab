import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JUnitParseError, parseJUnitXml } from '../../src/tools/daml/junit.js';

const passing = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Main.daml" tests="2" failures="0" errors="0">
    <testcase classname="Main" name="testHappyPath" time="0.01"/>
    <testcase classname="Main" name="testAnother" time="0.02"/>
  </testsuite>
</testsuites>`;

const failing = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Main.daml" tests="2" failures="1" errors="0">
    <testcase classname="Main" name="testOk"/>
    <testcase classname="Main" name="testAuthorization">
      <failure message="Submission failed">AuthorizationError: requires authorizers Alice</failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe('parseJUnitXml on passing output', () => {
  it('reports every case as passed', () => {
    const report = parseJUnitXml(passing);
    assert.equal(report.totals.tests, 2);
    assert.equal(report.totals.passed, 2);
    assert.equal(report.totals.failed, 0);
    assert.equal(report.suites.length, 1);

    const suite = report.suites[0];
    assert.ok(suite !== undefined);
    assert.equal(suite.name, 'Main.daml');

    const firstCase = suite.cases[0];
    assert.ok(firstCase !== undefined);
    assert.equal(firstCase.name, 'testHappyPath');
    assert.equal(firstCase.status, 'passed');
  });
});

describe('parseJUnitXml on failing output', () => {
  it('reports the failing case and preserves the failure detail', () => {
    const report = parseJUnitXml(failing);
    assert.equal(report.totals.tests, 2);
    assert.equal(report.totals.passed, 1);
    assert.equal(report.totals.failed, 1);

    const failure = report.suites[0]?.cases.find((item) => item.name === 'testAuthorization');
    assert.ok(failure !== undefined);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.message, 'Submission failed');
    assert.match(failure.detail ?? '', /AuthorizationError/);
  });
});

describe('parseJUnitXml on other shapes', () => {
  it('handles a bare testsuite root without a testsuites wrapper', () => {
    const report = parseJUnitXml(
      '<testsuite name="Solo"><testcase classname="Solo" name="one"/></testsuite>',
    );
    assert.equal(report.totals.tests, 1);
    assert.equal(report.suites[0]?.name, 'Solo');
  });

  it('classifies an error element as errored', () => {
    const report = parseJUnitXml(
      '<testsuites><testsuite name="S"><testcase classname="S" name="boom"><error message="crash"/></testcase></testsuite></testsuites>',
    );
    assert.equal(report.totals.errored, 1);
    assert.equal(report.suites[0]?.cases[0]?.status, 'errored');
  });

  it('classifies a skipped element as skipped', () => {
    const report = parseJUnitXml(
      '<testsuites><testsuite name="S"><testcase classname="S" name="later"><skipped/></testcase></testsuite></testsuites>',
    );
    assert.equal(report.totals.skipped, 1);
  });

  it('handles multiple suites', () => {
    const report = parseJUnitXml(
      '<testsuites><testsuite name="A"><testcase classname="A" name="a"/></testsuite><testsuite name="B"><testcase classname="B" name="b"/></testsuite></testsuites>',
    );
    assert.equal(report.suites.length, 2);
    assert.equal(report.totals.tests, 2);
  });

  it('reports a suite with no cases as zero tests rather than failing', () => {
    const report = parseJUnitXml('<testsuites><testsuite name="Empty"/></testsuites>');
    assert.equal(report.totals.tests, 0);
  });
});

describe('parseJUnitXml on malformed input', () => {
  const malformed: readonly (readonly [string, string])[] = [
    ['empty string', ''],
    ['whitespace only', '   \n  '],
    ['unclosed tag', '<testsuites><testsuite name="A">'],
    ['mismatched tags', '<testsuites></testsuite>'],
    ['not xml at all', 'dpm: command produced no output'],
    ['json instead of xml', '{"tests": 1}'],
  ];

  for (const [label, input] of malformed) {
    it(`throws on ${label}`, () => {
      assert.throws(
        () => parseJUnitXml(input),
        (error: unknown) => error instanceof JUnitParseError,
      );
    });
  }

  it('throws when the document has no testsuite element', () => {
    assert.throws(
      () => parseJUnitXml('<results><run/></results>'),
      (error: unknown) => error instanceof JUnitParseError,
    );
  });
});
