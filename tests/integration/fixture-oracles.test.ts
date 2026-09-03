// Integration verification for F02, F03 and F04, and the checked-in record of the
// oracle runs required by Constitution Article IX.
//
// Nothing here is mocked: each fixture is built and its host-owned, independently
// reviewed oracle is run on the pinned Daml 3.5.5 toolchain through the same
// deterministic wrappers used by the system, and outcomes are read from JUnit XML
// rather than from console text.
//
// F01 has its own file. It was verified first and is the reference the others were
// modelled on, so it is left alone rather than folded into this table.
//
// Requires the pinned toolchain, so it is not part of `npm run test:unit` and does
// not run in CI, which has no Daml installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { HOST_ONLY_FIXTURE_ENTRIES, materializeTargetView } from '../../src/eval/analysisView.js';
import { ExpectedSchema } from '../../src/schemas/expected.js';
import { createWorkspace } from '../../src/security/paths.js';
import { damlBuild } from '../../src/tools/daml/build.js';
import { damlTest } from '../../src/tools/daml/test.js';
import type { JUnitReport } from '../../src/tools/daml/junit.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspace = createWorkspace(repoRoot);

// Daml compilation and script execution dominate this; the host wrapper adds nothing.
const TOOLCHAIN_TIMEOUT_MS = 600_000;

interface FixtureCase {
  /** Directory under `fixtures/`, which is also the `fixtureId`. */
  readonly id: string;
  /** Vulnerable module, for the immutability check. */
  readonly source: string;
  /** Scripts that must run, beyond the documented entry point. */
  readonly scripts: readonly string[];
  /** What the exploit script demonstrates, in the fixture's own terms. */
  readonly intent: string;
}

const FIXTURES: readonly FixtureCase[] = [
  {
    id: 'f02-observer-exposure',
    source: 'main/daml/Payroll.daml',
    scripts: ['privacyQueryProbe', 'exploitVendorReadsCompensation', 'negativeControlVendorScope'],
    intent: 'the vendor reads compensation data it should not be a stakeholder of',
  },
  {
    id: 'f03-missing-multiparty',
    source: 'main/daml/JointAccount.daml',
    scripts: [
      'exploitSingleHolderWithdraws',
      'negativeControlAuthorizationError',
      'bothHoldersTogetherSucceed',
    ],
    intent: 'one joint holder withdraws without the other holder authorizing it',
  },
  {
    id: 'f04-propose-accept-bypass',
    source: 'main/daml/Trade.daml',
    scripts: [
      'exploitSellerReachesSettledStateAlone',
      'negativeControlCannotForgeBuyerAuthority',
      'intendedAcceptPathSucceeds',
    ],
    intent: 'the seller reaches a settled trade state without the buyer accepting',
  },
];

const junits = new Map<string, JUnitReport>();
/** Digests of every host-owned file, taken before the toolchain runs. */
const digestsBefore = new Map<string, string>();
const tempRoots: string[] = [];

function hostOwnedFiles(fixture: FixtureCase): string[] {
  return [
    path.join('fixtures', fixture.id, 'expected.json'),
    path.join('fixtures', fixture.id, fixture.source),
    path.join('fixtures', fixture.id, 'test', 'daml', 'Oracle.daml'),
  ];
}

function digest(relativePath: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repoRoot, relativePath)))
    .digest('hex');
}

before(async () => {
  for (const fixture of FIXTURES) {
    for (const file of hostOwnedFiles(fixture)) {
      digestsBefore.set(file, digest(file));
    }

    const fixtureRoot = path.join('fixtures', fixture.id);

    const build = await damlBuild(workspace, {
      packageRoot: fixtureRoot,
      all: true,
      timeoutMs: TOOLCHAIN_TIMEOUT_MS,
    });

    assert.equal(
      build.succeeded,
      true,
      `${fixture.id}: dpm build --all failed:\n${build.diagnostics}`,
    );
    assert.equal(build.exitCode, 0);

    const result = await damlTest(workspace, {
      packageRoot: path.join(fixtureRoot, 'test'),
      timeoutMs: TOOLCHAIN_TIMEOUT_MS,
    });

    assert.equal(
      result.junitParseError,
      undefined,
      `${fixture.id}: JUnit output was unusable: ${result.junitParseError ?? ''}`,
    );
    assert.ok(result.junit !== undefined, `${fixture.id}: dpm test produced no JUnit report`);
    assert.equal(
      result.exitCode,
      0,
      `${fixture.id}: dpm test exited non-zero:\n${result.diagnostics}`,
    );

    junits.set(fixture.id, result.junit);
  }
});

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { force: true, recursive: true });
});

function statusOf(fixtureId: string, scriptName: string): string | undefined {
  const junit = junits.get(fixtureId);
  if (junit === undefined) return undefined;
  for (const suite of junit.suites) {
    const found = suite.cases.find((testCase) => testCase.name === scriptName);
    if (found !== undefined) return found.status;
  }
  return undefined;
}

function expectationFor(fixtureId: string): ReturnType<typeof ExpectedSchema.parse> {
  const raw = fs.readFileSync(path.join(repoRoot, 'fixtures', fixtureId, 'expected.json'), 'utf8');
  return ExpectedSchema.parse(JSON.parse(raw));
}

for (const fixture of FIXTURES) {
  describe(`${fixture.id} builds on the pinned toolchain`, () => {
    it('produces both package DARs', () => {
      for (const suffix of ['main', 'test']) {
        const dar = path.join(
          'fixtures',
          fixture.id,
          suffix,
          '.daml',
          'dist',
          `${fixture.id}-${suffix}-1.0.0.dar`,
        );
        assert.ok(fs.existsSync(path.join(repoRoot, dar)), `missing ${dar}`);
      }
    });

    it('leaves its build output untracked', () => {
      // The DAR and the .daml directory are real files on disk. They must be
      // ignored, or a verification run would dirty the working tree.
      for (const artifact of [
        path.join('fixtures', fixture.id, 'main', '.daml'),
        path.join('fixtures', fixture.id, 'main', '.daml', 'dist', `${fixture.id}-main-1.0.0.dar`),
      ]) {
        const ignored = execFileSync('git', ['check-ignore', artifact], {
          cwd: repoRoot,
          encoding: 'utf8',
        });
        assert.equal(ignored.trim(), artifact);
      }
    });
  });

  describe(`${fixture.id} oracle outcome`, () => {
    it('runs the whole oracle with no failures or errors', () => {
      const junit = junits.get(fixture.id);
      assert.ok(junit !== undefined);
      assert.equal(junit.totals.failed, 0);
      assert.equal(junit.totals.errored, 0);
      assert.ok(
        junit.totals.tests >= fixture.scripts.length + 1,
        `expected at least ${fixture.scripts.length + 1} scripts, saw ${junit.totals.tests}`,
      );
    });

    it(`observes the documented intent: ${fixture.intent}`, () => {
      // Every script the oracle documents ran and passed. The exploit scripts are
      // deliberately not `submitMustFail`: they assert that the vulnerable
      // transition SUCCEEDS, so a failure here would mean the defect had been
      // repaired rather than that the oracle was wrong.
      for (const script of fixture.scripts) {
        assert.equal(statusOf(fixture.id, script), 'passed', `${script} did not pass`);
      }
    });

    it('records the documented oracle entry point as passing', () => {
      const [, scriptName] = expectationFor(fixture.id).oracleScript.split(':');
      assert.equal(statusOf(fixture.id, scriptName ?? ''), 'passed');
    });
  });

  describe(`${fixture.id} expectation file`, () => {
    it('is valid against the host expectation schema', () => {
      const raw = fs.readFileSync(
        path.join(repoRoot, 'fixtures', fixture.id, 'expected.json'),
        'utf8',
      );
      const parsed = ExpectedSchema.safeParse(JSON.parse(raw));
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    });

    it('identifies itself and pins the toolchain it was verified on', () => {
      const expected = expectationFor(fixture.id);
      assert.equal(expected.fixtureId, fixture.id);
      assert.equal(expected.damlSdkVersion, '3.5.5');
    });

    it('stays host-owned: withheld from the view an evaluated model sees', () => {
      const destination = fs.mkdtempSync(path.join(os.tmpdir(), `${fixture.id}-view-`));
      tempRoots.push(destination);

      const view = materializeTargetView({
        sourceRoot: path.join(repoRoot, 'fixtures', fixture.id),
        destination,
        hostOnlyEntries: HOST_ONLY_FIXTURE_ENTRIES,
      });

      assert.equal(fs.existsSync(path.join(destination, 'expected.json')), false);
      assert.equal(fs.existsSync(path.join(destination, 'test')), false);
      for (const included of view.includedFiles) {
        assert.equal(included.startsWith('test/'), false);
        assert.notEqual(included, 'expected.json');
      }

      // The vulnerable source itself must survive: withholding the answer must not
      // withhold the thing to be analysed.
      assert.ok(fs.existsSync(path.join(destination, fixture.source)));
    });
  });

  describe(`${fixture.id} fixture integrity`, () => {
    it('is not mutated by building or running its oracle', () => {
      for (const file of hostOwnedFiles(fixture)) {
        assert.equal(digest(file), digestsBefore.get(file), `${file} changed during verification`);
      }
    });
  });
}
