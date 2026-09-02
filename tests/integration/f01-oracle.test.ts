// Integration verification for F01, and the checked-in record of the oracle run
// required by Constitution Article IX.
//
// Nothing here is mocked: this builds the fixture and runs the host-owned,
// independently reviewed oracle on the pinned Daml 3.5.5 toolchain through the same
// deterministic wrappers used by the system, and reads outcomes from JUnit XML
// rather than from console text.
//
// Requires the pinned toolchain, so it is not part of `npm run test:unit` and does
// not run in CI, which has no Daml installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';

import { ExpectedSchema } from '../../src/schemas/expected.js';
import { createWorkspace } from '../../src/security/paths.js';
import { damlBuild } from '../../src/tools/daml/build.js';
import { damlTest } from '../../src/tools/daml/test.js';
import type { JUnitReport } from '../../src/tools/daml/junit.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspace = createWorkspace(repoRoot);

const FIXTURE = 'fixtures/f01-wrong-controller';
const TEST_PACKAGE = `${FIXTURE}/test`;

// Daml compilation and script execution dominate this; the host wrapper adds nothing.
const TOOLCHAIN_TIMEOUT_MS = 600_000;

const EXPLOIT_SCRIPT = 'exploitSucceeds';
const NEGATIVE_CONTROL_SCRIPT = 'negativeControlAuthorizationError';
const ORACLE_SCRIPT = 'oracle';

let junit: JUnitReport;

before(async () => {
  const build = await damlBuild(workspace, {
    packageRoot: FIXTURE,
    all: true,
    timeoutMs: TOOLCHAIN_TIMEOUT_MS,
  });

  assert.equal(build.succeeded, true, `dpm build --all failed:\n${build.diagnostics}`);
  assert.equal(build.exitCode, 0);

  const result = await damlTest(workspace, {
    packageRoot: TEST_PACKAGE,
    timeoutMs: TOOLCHAIN_TIMEOUT_MS,
  });

  assert.equal(
    result.junitParseError,
    undefined,
    `JUnit output was unusable: ${result.junitParseError ?? ''}`,
  );
  assert.ok(result.junit !== undefined, 'dpm test produced no JUnit report');
  assert.equal(result.exitCode, 0, `dpm test exited non-zero:\n${result.diagnostics}`);

  junit = result.junit;
});

function statusOf(name: string): string | undefined {
  for (const suite of junit.suites) {
    const found = suite.cases.find((testCase) => testCase.name === name);
    if (found !== undefined) return found.status;
  }
  return undefined;
}

describe('F01 builds and its DARs are produced', () => {
  it('produces both package DARs', () => {
    for (const dar of [
      `${FIXTURE}/main/.daml/dist/f01-wrong-controller-main-1.0.0.dar`,
      `${FIXTURE}/test/.daml/dist/f01-wrong-controller-test-1.0.0.dar`,
    ]) {
      assert.ok(fs.existsSync(path.join(repoRoot, dar)), `missing ${dar}`);
    }
  });
});

describe('F01 oracle outcome on the pinned toolchain', () => {
  it('runs the whole oracle with no failures or errors', () => {
    assert.equal(junit.totals.failed, 0);
    assert.equal(junit.totals.errored, 0);
    assert.ok(junit.totals.tests >= 3, `expected at least 3 scripts, saw ${junit.totals.tests}`);
  });

  it('records the exploit as succeeding, which is the vulnerability evidence', () => {
    // The custodian's unauthorized transfer is expected to SUCCEED under the buggy
    // controller. A failure here would mean the defect had been repaired.
    assert.equal(statusOf(EXPLOIT_SCRIPT), 'passed');
  });

  it('records the typed authorization negative control as passing', () => {
    // The legitimate owner is refused with AuthorizationError specifically, which is
    // what shows the exploit succeeds because of the controller rather than because
    // authorization is not being enforced.
    assert.equal(statusOf(NEGATIVE_CONTROL_SCRIPT), 'passed');
  });

  it('records the documented oracle entry point as passing', () => {
    assert.equal(statusOf(ORACLE_SCRIPT), 'passed');
  });
});

describe('F01 expectation file', () => {
  it('is valid against the host expectation schema', () => {
    const raw = fs.readFileSync(path.join(repoRoot, FIXTURE, 'expected.json'), 'utf8');
    const parsed = ExpectedSchema.safeParse(JSON.parse(raw));
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  it('names an oracle script that actually ran', () => {
    const raw = fs.readFileSync(path.join(repoRoot, FIXTURE, 'expected.json'), 'utf8');
    const expected = ExpectedSchema.parse(JSON.parse(raw));
    const [, scriptName] = expected.oracleScript.split(':');
    assert.equal(statusOf(scriptName ?? ''), 'passed');
  });

  it('pins the toolchain the oracle was verified on', () => {
    const raw = fs.readFileSync(path.join(repoRoot, FIXTURE, 'expected.json'), 'utf8');
    assert.equal(ExpectedSchema.parse(JSON.parse(raw)).damlSdkVersion, '3.5.5');
  });
});
