// Phase 9: the conditional revision graph, the revision budget, and the
// confirmation gate.
//
// The question every test here asks is the same one: can anything the model
// says move the run? The branch out of `execute` is taken on a host-computed
// boolean, the budget lives on the machine, and `confirmed` requires an
// execution the host observed. None of the three is reachable from an artifact.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyConfirmationGate,
  gateFindings,
  hasConfirmingExecution,
} from '../../src/agent/confirmation.js';
import { PhaseMachine, PhaseTransitionError } from '../../src/agent/phases.js';
import { revisionReasonFor } from '../../src/agent/steps/revise.js';
import { MODEL_LOOP_DEFAULTS } from '../../src/config.js';
import type { Finding } from '../../src/schemas/findings.js';
import {
  ExecuteArtifactSchema,
  type ExecuteArtifact,
  type TestOutcome,
} from '../../src/schemas/phases.js';

/** Advance a fresh machine to `execute` the way a real run would. */
function machineAtExecute(maxRevisions?: number): PhaseMachine {
  const machine = new PhaseMachine(maxRevisions === undefined ? {} : { maxRevisions });
  while (machine.current !== 'execute') {
    machine.advance({ validArtifact: true });
  }
  return machine;
}

function executionWith(outcome: TestOutcome): ExecuteArtifact {
  const compiled = outcome !== 'compile_failed';
  return ExecuteArtifactSchema.parse({
    phase: 'execute',
    results: [
      {
        testId: 'gt-1',
        attempt: 1,
        outcome,
        compiled,
        ...(outcome === 'compile_failed' || outcome === 'execution_failed'
          ? {}
          : { passed: outcome === 'executed_expected' }),
        compileEvidenceId: 'ev_00000000000000c0',
        ...(compiled ? { evidenceId: 'ev_00000000000000e0' } : {}),
      },
    ],
    evidence: [{ evidenceId: 'ev_00000000000000c0' }],
  });
}

describe('the no-revision path', () => {
  it('goes straight to report when the result matched the declared expectation', () => {
    const machine = machineAtExecute();

    assert.equal(machine.advance({ validArtifact: true, revisionRequired: false }), 'report');
    assert.equal(machine.revisions, 0);
    assert.equal(machine.revisionExhausted, false);
  });

  it('does not treat a test that failed as predicted as a reason to revise', () => {
    // An adversarial test that predicted failure and failed is working exactly
    // as designed. Revising it would be arguing with the evidence.
    const expected = executionWith('executed_expected');
    assert.equal(revisionReasonFor(expected.results), undefined);
  });
});

describe('the revision paths', () => {
  it('enters revise on a compile failure and returns to execute', () => {
    const machine = machineAtExecute();

    assert.equal(machine.advance({ validArtifact: true, revisionRequired: true }), 'revise');
    assert.equal(machine.revisions, 1);
    // A revised test is never assumed correct: it must run again.
    assert.equal(machine.advance({ validArtifact: true }), 'execute');
    assert.equal(revisionReasonFor(executionWith('compile_failed').results), 'compilation_failure');
  });

  it('enters revise on a contradicted expectation', () => {
    const machine = machineAtExecute();
    assert.equal(
      revisionReasonFor(executionWith('executed_contradiction').results),
      'contradicted_expectation',
    );

    assert.equal(machine.advance({ validArtifact: true, revisionRequired: true }), 'revise');
    assert.equal(machine.advance({ validArtifact: true }), 'execute');
    assert.equal(machine.current, 'execute');
  });

  it('does not revise when the run only failed to observe a result', () => {
    // Compiled, but nothing was reported for it. The test may be fine and the
    // observation the broken part, so correcting the test would be a guess.
    assert.equal(revisionReasonFor(executionWith('execution_failed').results), undefined);
  });
});

describe('the revision budget', () => {
  it('is host-owned and small by default', () => {
    const budget: number = MODEL_LOOP_DEFAULTS.maxRevisions;
    assert.equal(budget, 2);
    assert.equal(new PhaseMachine().maxRevisions, budget);
  });

  it('stops revising once spent and reports in an exhausted state', () => {
    const machine = machineAtExecute(2);

    for (let round = 1; round <= 2; round += 1) {
      assert.equal(machine.advance({ validArtifact: true, revisionRequired: true }), 'revise');
      assert.equal(machine.revisions, round);
      assert.equal(machine.advance({ validArtifact: true }), 'execute');
    }

    // Third time: still broken, no budget left. The run proceeds to report,
    // flagged, rather than looping or pretending the attempt succeeded.
    assert.equal(machine.advance({ validArtifact: true, revisionRequired: true }), 'report');
    assert.equal(machine.revisions, 2);
    assert.equal(machine.revisionExhausted, true);
  });

  it('cannot be raised, reset, or spent past its maximum', () => {
    const machine = machineAtExecute(1);
    machine.advance({ validArtifact: true, revisionRequired: true });
    machine.advance({ validArtifact: true });

    // There is no setter to call: the count and the maximum are read-only, and
    // the only way to move the machine is `advance`.
    assert.equal(machine.revisions, 1);
    assert.equal('maxRevisions' in Object.getOwnPropertyDescriptors(machine), false);
    assert.throws(() => new PhaseMachine({ maxRevisions: -1 }), PhaseTransitionError);

    assert.equal(machine.advance({ validArtifact: true, revisionRequired: true }), 'report');
    assert.equal(machine.revisions, 1);
  });

  it('terminates: a run that always needs revision still reaches report', () => {
    const machine = machineAtExecute();
    let guard = 0;

    while (machine.current !== 'report') {
      guard += 1;
      assert.ok(guard < 20, 'the revision cycle must not loop indefinitely');
      if (machine.current === 'execute') {
        machine.advance({ validArtifact: true, revisionRequired: true });
      } else {
        machine.advance({ validArtifact: true });
      }
    }
    assert.equal(machine.revisionExhausted, true);
  });
});

describe('illegal transitions', () => {
  it('will not leave execute without an explicit host decision', () => {
    const machine = machineAtExecute();
    // Defaulting this would let an unobserved run continue as if it had been
    // checked, so the omission is an error rather than a false.
    assert.throws(() => machine.advance({ validArtifact: true }), PhaseTransitionError);
    assert.equal(machine.current, 'execute');
  });

  it('rejects a revision decision offered anywhere else', () => {
    const machine = new PhaseMachine();
    assert.throws(
      () => machine.advance({ validArtifact: true, revisionRequired: false }),
      PhaseTransitionError,
    );
    assert.equal(machine.current, 'understand');
  });

  it('refuses every phase a model might name', () => {
    const machine = machineAtExecute();
    for (const declared of ['revise', 'report', 'generate_tests', 'evaluate', 'understand']) {
      assert.throws(() => {
        machine.assertExpectedPhase(declared);
      }, PhaseTransitionError);
    }
    assert.equal(machine.current, 'execute');
  });

  it('cannot skip execute to reach report', () => {
    const machine = new PhaseMachine();
    while (machine.current !== 'generate_tests') machine.advance({ validArtifact: true });

    // The only successor of generate_tests is execute. There is no argument
    // that produces anything else.
    assert.equal(machine.advance({ validArtifact: true }), 'execute');
  });

  it('cannot re-enter an earlier analysis phase', () => {
    const machine = machineAtExecute();
    machine.advance({ validArtifact: true, revisionRequired: true });
    assert.equal(machine.current, 'revise');
    // revise leads to execute and nowhere else; nothing goes back to scenarios.
    assert.equal(machine.advance({ validArtifact: true }), 'execute');
  });

  it('will not advance on an invalid artifact even when revision is needed', () => {
    const machine = machineAtExecute();
    assert.throws(
      () => machine.advance({ validArtifact: false, revisionRequired: true }),
      PhaseTransitionError,
    );
    assert.equal(machine.revisions, 0);
  });
});

// --- confirmation gate (T065) ----------------------------------------------

const claim: Finding = {
  id: 'f-1',
  class: 'incorrect_controller',
  title: 'A choice names the wrong controller',
  detail: 'Asserted by the model.',
  severity: 'high',
  state: 'confirmed',
  evidence: [{ evidenceId: 'ev_00000000000000c0' }],
};

describe('confirmation gate', () => {
  it('confirms only when a supporting test ran and matched its prediction', () => {
    const decision = applyConfirmationGate(executionWith('executed_expected'), {
      finding: claim,
      supportingTestIds: ['gt-1'],
    });

    assert.equal(decision.downgraded, false);
    assert.equal(decision.finding.state, 'confirmed');
  });

  it('never confirms a conclusion whose test did not compile', () => {
    const decision = applyConfirmationGate(executionWith('compile_failed'), {
      finding: claim,
      supportingTestIds: ['gt-1'],
    });

    assert.equal(decision.downgraded, true);
    assert.equal(decision.finding.state, 'unconfirmed');
    assert.match(decision.reason ?? '', /never compiled/);
    // Downgraded, not discarded: the evidence is still worth reporting.
    assert.deepEqual(decision.finding.evidence, claim.evidence);
  });

  it('does not confirm on a contradicted result', () => {
    const decision = applyConfirmationGate(executionWith('executed_contradiction'), {
      finding: claim,
      supportingTestIds: ['gt-1'],
    });

    assert.equal(decision.finding.state, 'unconfirmed');
    assert.match(decision.reason ?? '', /contradicted/);
  });

  it('does not confirm when nothing was executed in support of the claim', () => {
    for (const supporting of [[], ['gt-other']]) {
      const decision = applyConfirmationGate(executionWith('executed_expected'), {
        finding: claim,
        supportingTestIds: supporting,
      });
      assert.equal(decision.finding.state, 'unconfirmed');
    }
  });

  it('does not confirm on an unobserved execution', () => {
    assert.equal(hasConfirmingExecution(executionWith('execution_failed'), ['gt-1']), false);
  });

  it('leaves weaker claims alone', () => {
    const unconfirmed: Finding = { ...claim, state: 'unconfirmed' };
    const decisions = gateFindings(executionWith('compile_failed'), [
      { finding: unconfirmed, supportingTestIds: ['gt-1'] },
    ]);

    const decision = decisions[0];
    assert.ok(decision);
    assert.equal(decision.downgraded, false);
    assert.equal(decision.finding.state, 'unconfirmed');
  });

  it('ignores what the model asserted about its own certainty', () => {
    // The finding says `confirmed` and reads confidently. The gate consults the
    // execution record instead, which is the only thing that saw anything.
    const overconfident: Finding = {
      ...claim,
      detail: 'This is definitively confirmed and fully verified by our testing.',
    };
    const decision = applyConfirmationGate(executionWith('compile_failed'), {
      finding: overconfident,
      supportingTestIds: ['gt-1'],
    });

    assert.equal(decision.finding.state, 'unconfirmed');
  });
});
