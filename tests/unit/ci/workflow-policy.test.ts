import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Assertion 4-B — untrusted fork PR execution boundary (declaration half).
 * Specified in design §9.5.3.7; rationale in docs/security/ci-security-model.md §4.
 *
 * WHAT THIS FILE PROVES: that `.github/workflows/ci.yml` *declares* the approved
 * boundary and nothing weaker.
 *
 * WHAT THIS FILE DOES NOT PROVE:
 *   * That the repository permits only these permissions. A workflow block can
 *     lower the token, never raise it, and it says nothing about the repository
 *     default. That half is the manual checklist in
 *     docs/security/ci-security-model.md §7 and is NOT verified here.
 *   * That no external request is made. External egress is accepted (D5).
 *   * Anything about the workflow that actually runs for a given PR: this reads
 *     a file, and a malicious PR could change both the file and this test.
 *
 * It is therefore declaration evidence, not independent evidence against a PR
 * author. Assertion 4, B-6, O-3 and T-10a remain BLOCKED.
 *
 * No YAML dependency is used. Parsing is done with a small purpose-built reader
 * over the workflow's actual shape so that the checks cannot silently pass on a
 * file a real YAML parser would reject differently. Structural expectations are
 * asserted first, so a malformed file fails loudly instead of vacuously passing.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflowPath = path.join(repoRoot, '.github/workflows/ci.yml');

const source = readFileSync(workflowPath, 'utf8');

/** Non-comment lines, so checks never match documentation inside a comment. */
const codeLines = source.split('\n').filter((line) => !line.trimStart().startsWith('#'));

const code = codeLines.join('\n');

/** Indentation of a line, counting leading spaces only. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

describe('4-B workflow file is structurally present', () => {
  it('exists and is non-trivial', () => {
    expect(source.length).toBeGreaterThan(200);
    expect(codeLines.length).toBeGreaterThan(20);
  });

  it('declares the expected top-level sections', () => {
    for (const key of ['name:', 'on:', 'permissions:', 'jobs:']) {
      expect(code).toContain(key);
    }
    expect(code).toMatch(/^jobs:\s*$/m);
  });

  it('declares exactly one job in the expected shape', () => {
    // The checks below assume a single `verify` job; assert that assumption so
    // a restructure cannot leave them silently scanning nothing.
    const jobKeys = codeLines.filter(
      (l) => indentOf(l) === 2 && /^\s{2}\S/.test(l) && l.trimEnd().endsWith(':'),
    );
    expect(jobKeys.length).toBeGreaterThan(0);
    expect(code).toContain('  verify:');
  });
});

describe('4-B runner is GitHub-hosted ubuntu-24.04', () => {
  it('pins runs-on to ubuntu-24.04', () => {
    expect(code).toMatch(/^\s+runs-on:\s*ubuntu-24\.04\s*$/m);
  });

  it('never uses ubuntu-slim', () => {
    expect(code).not.toMatch(/ubuntu-slim/);
  });

  it('never uses a self-hosted runner', () => {
    expect(code).not.toMatch(/self-hosted/i);
  });

  it('never uses a runner group or a matrix expression for runs-on', () => {
    expect(code).not.toMatch(/runs-on:\s*\$\{\{/);
    expect(code).not.toMatch(/runner-group/i);
  });
});

describe('4-B permissions are read-only and closed', () => {
  it('declares a workflow-level permissions block', () => {
    expect(code).toMatch(/^permissions:\s*$/m);
  });

  it('grants contents: read', () => {
    expect(code).toMatch(/^\s+contents:\s*read\s*$/m);
  });

  it('never grants contents: write', () => {
    expect(code).not.toMatch(/contents:\s*write/);
  });

  it('never grants pull-requests: write', () => {
    expect(code).not.toMatch(/pull-requests:\s*write/);
  });

  it('never requests id-token (OIDC)', () => {
    expect(code).not.toMatch(/id-token/);
  });

  it('never grants packages, security-events, actions, or statuses write', () => {
    for (const scope of [
      'packages',
      'security-events',
      'actions',
      'statuses',
      'checks',
      'deployments',
    ]) {
      expect(code).not.toMatch(new RegExp(`${scope}:\\s*write`));
    }
  });

  it('never uses write-all', () => {
    expect(code).not.toMatch(/write-all/);
  });

  it('only names read scopes, and only contents', () => {
    const granted = [...code.matchAll(/^\s+([a-z-]+):\s*(read|write|none)\s*$/gm)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    // The permission block is the only place these scope:value pairs appear.
    expect(granted).toEqual(['contents:read']);
  });
});

describe('4-B no secrets and no credentials reach the job', () => {
  it('never references the secrets context', () => {
    expect(code).not.toMatch(/secrets\./);
    expect(code).not.toMatch(/\bsecrets\b\s*:/);
  });

  it('never references GEMINI_API_KEY', () => {
    expect(code).not.toMatch(/GEMINI_API_KEY/);
  });

  it('never configures registry auth or NODE_AUTH_TOKEN', () => {
    expect(code).not.toMatch(/registry-url/);
    expect(code).not.toMatch(/NODE_AUTH_TOKEN/);
    expect(code).not.toMatch(/npmrc/);
  });

  it('never enables credential persistence on checkout', () => {
    // persist-credentials defaults to true; it must be explicitly disabled.
    expect(code).toMatch(/persist-credentials:\s*false/);
  });
});

describe('4-B tests select the Fake Gemini provider explicitly', () => {
  it('sets LLM_PROVIDER to fake in the environment', () => {
    expect(code).toMatch(/LLM_PROVIDER:\s*fake/);
  });

  it('never sets LLM_PROVIDER to gemini', () => {
    expect(code).not.toMatch(/LLM_PROVIDER:\s*["']?gemini/);
  });
});

describe('4-B caching is fully disabled', () => {
  it('sets package-manager-cache to false', () => {
    expect(code).toMatch(/package-manager-cache:\s*false/);
  });

  it('never sets an explicit setup-node cache input', () => {
    // `cache:` as an input would re-enable caching independently of
    // package-manager-cache. Anchored to an input-shaped key so the
    // `concurrency:`/`permissions:` blocks cannot match.
    expect(code).not.toMatch(/^\s*(?:-\s+)?cache:\s*\S/m);
  });

  it('never uses actions/cache in any form', () => {
    expect(code).not.toMatch(/actions\/cache/);
  });

  it('never uses artifact transfer between jobs', () => {
    expect(code).not.toMatch(/upload-artifact/);
    expect(code).not.toMatch(/download-artifact/);
  });
});

describe('4-B dependencies install with ordinary npm ci', () => {
  it('runs npm ci', () => {
    expect(code).toMatch(/npm ci/);
  });

  it('does not disable lifecycle scripts', () => {
    expect(code).not.toMatch(/--ignore-scripts/);
  });

  it('does not use npm install or npm i as the install step', () => {
    expect(code).not.toMatch(/npm (install|i)\b/);
  });
});

describe('4-B actions are official, pinned, and declared', () => {
  /**
   * Every `uses:` value in the workflow, in order.
   *
   * The optional `- ` prefix is required: a step may be written either as
   * `- name: X` + `  uses: Y` or as `- uses: Y`. Matching only the second form
   * would silently miss the first, so both are accepted here. (This exact gap
   * was found by mutation testing: a third-party action added as `- uses:`
   * was not detected.)
   */
  const usesValues = [...code.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)\s*$/gm)].map(
    (m) => m[1] as string,
  );

  it('uses at least one action and declares each as owner/repo@ref', () => {
    expect(usesValues.length).toBeGreaterThan(0);
    for (const value of usesValues) {
      expect(value).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
    }
  });

  it('pins every action to a full 40-character commit SHA', () => {
    for (const value of usesValues) {
      const ref = value.slice(value.lastIndexOf('@') + 1);
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('never pins to a version-like tag or a branch name', () => {
    for (const value of usesValues) {
      const ref = value.slice(value.lastIndexOf('@') + 1);
      // A full SHA may legitimately start with a digit, so the check targets
      // the *shape* of a tag (v4, v4.2.1, 4.2.1) or a branch, not a leading digit.
      expect(ref).not.toMatch(/^v?\d+(\.\d+)*$/);
      expect(ref).not.toMatch(/^(main|master|HEAD|develop)$/);
      expect(ref).not.toMatch(/\//);
    }
  });

  it('uses only actions under the official actions/ and github/ owners', () => {
    for (const value of usesValues) {
      const owner = value.split('/')[0];
      expect(['actions', 'github']).toContain(owner);
    }
  });

  it('uses only the two expected actions, with no third-party additions', () => {
    const names = usesValues.map((v) => v.split('@')[0]).sort();
    expect(names).toEqual(['actions/checkout', 'actions/setup-node']);
  });

  it('uses no Docker actions and no local composite actions', () => {
    expect(code).not.toMatch(/docker:\/\//);
    expect(code).not.toMatch(/uses:\s*\.\//);
  });
});

describe('4-B the workflow does not exceed the boundary in other ways', () => {
  it('does not use pull_request_target', () => {
    expect(code).not.toMatch(/pull_request_target/);
  });

  it('does not use workflow_run', () => {
    expect(code).not.toMatch(/workflow_run/);
  });

  it('does not use pull_request_review or issue_comment triggers', () => {
    expect(code).not.toMatch(/pull_request_review/);
    expect(code).not.toMatch(/issue_comment/);
  });
});
