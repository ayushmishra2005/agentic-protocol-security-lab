/**
 * JUnit XML parsing for `dpm test --junit`.
 *
 * Test outcomes are read from the machine-readable JUnit file rather than from
 * human stdout, so an evidence record cannot drift with a cosmetic change to
 * the CLI's console formatting.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export class JUnitParseError extends Error {
  override readonly name = 'JUnitParseError';
}

export type JUnitCaseStatus = 'passed' | 'failed' | 'errored' | 'skipped';

export interface JUnitTestCase {
  readonly name: string;
  readonly classname: string;
  readonly status: JUnitCaseStatus;
  readonly message?: string;
  readonly detail?: string;
}

export interface JUnitSuite {
  readonly name: string;
  readonly cases: readonly JUnitTestCase[];
}

export interface JUnitReport {
  readonly suites: readonly JUnitSuite[];
  readonly totals: {
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    readonly errored: number;
    readonly skipped: number;
  };
}

type XmlNode = Record<string, unknown>;

function toArray(value: unknown): XmlNode[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value))
    return value.filter((item): item is XmlNode => typeof item === 'object');
  if (typeof value === 'object') return [value as XmlNode];
  return [];
}

function attr(node: XmlNode, name: string): string | undefined {
  const value = node[`@_${name}`];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const inner = (value as XmlNode)['#text'];
    if (typeof inner === 'string') return inner;
  }
  return undefined;
}

function parseCase(node: XmlNode): JUnitTestCase {
  const name = attr(node, 'name') ?? '';
  const classname = attr(node, 'classname') ?? '';

  const failures = toArray(node['failure']);
  const errors = toArray(node['error']);
  const skipped = node['skipped'] !== undefined;

  const problem = failures[0] ?? errors[0];
  if (problem !== undefined) {
    const message = attr(problem, 'message');
    const detail = textOf(problem);
    return {
      name,
      classname,
      status: failures.length > 0 ? 'failed' : 'errored',
      ...(message === undefined ? {} : { message }),
      ...(detail === undefined ? {} : { detail }),
    };
  }

  // A bare <failure/> element has no attributes and parses to an empty string.
  if (typeof node['failure'] === 'string' || node['failure'] === '') {
    return { name, classname, status: 'failed' };
  }
  if (typeof node['error'] === 'string' || node['error'] === '') {
    return { name, classname, status: 'errored' };
  }

  return { name, classname, status: skipped ? 'skipped' : 'passed' };
}

/** Parse JUnit XML. Throws `JUnitParseError` on malformed or unrecognised input. */
export function parseJUnitXml(xml: string): JUnitReport {
  if (xml.trim().length === 0) {
    throw new JUnitParseError('JUnit output was empty.');
  }

  // XMLParser alone silently recovers from unclosed and mismatched tags, which
  // would let a truncated results file be read as a passing run. Validating
  // first is what makes that case an error. XMLValidator is marked deprecated
  // in favour of a separate package; it is kept here because the replacement
  // pulls in three further dependencies to solve a problem this already solves.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new JUnitParseError(`JUnit output is not well-formed XML: ${validation.err.msg}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    parseTagValue: false,
  });

  let document: XmlNode;
  try {
    document = parser.parse(xml) as XmlNode;
  } catch (error) {
    throw new JUnitParseError(
      `Failed to parse JUnit output: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const root = document['testsuites'];
  const suiteNodes =
    root !== undefined ? toArray((root as XmlNode)['testsuite']) : toArray(document['testsuite']);

  if (suiteNodes.length === 0 && root === undefined && document['testsuite'] === undefined) {
    throw new JUnitParseError('JUnit output contained no <testsuite> or <testsuites> element.');
  }

  const suites: JUnitSuite[] = suiteNodes.map((suiteNode) => ({
    name: attr(suiteNode, 'name') ?? '',
    cases: toArray(suiteNode['testcase']).map(parseCase),
  }));

  const totals = { tests: 0, passed: 0, failed: 0, errored: 0, skipped: 0 };
  for (const suite of suites) {
    for (const testCase of suite.cases) {
      totals.tests += 1;
      if (testCase.status === 'passed') totals.passed += 1;
      else if (testCase.status === 'failed') totals.failed += 1;
      else if (testCase.status === 'errored') totals.errored += 1;
      else totals.skipped += 1;
    }
  }

  return { suites, totals };
}
