/**
 * Runs every suite. No dependencies, no install:
 *
 *   node worker/tests/run.mjs           everything
 *   node worker/tests/run.mjs slip      just the suites whose file matches
 *
 * Exits non-zero on any failure, so it works as a pre-deploy gate.
 */

import { report } from './harness.mjs';

const SUITES = [
  ['expenses', () => import('./expenses.test.mjs')],
  ['inquiry', () => import('./inquiry.test.mjs')],
  ['lib', () => import('./lib.test.mjs')],
  ['quote', () => import('./quote.test.mjs')],
  ['recovery', () => import('./recovery.test.mjs')],
  ['slip', () => import('./slip.test.mjs')],
  ['uploads', () => import('./uploads.test.mjs')],
  ['worker', () => import('./worker.test.mjs')],
];

const filter = process.argv[2];
const selected = filter ? SUITES.filter(([name]) => name.includes(filter)) : SUITES;

if (!selected.length) {
  console.error(`No suite matches "${filter}". Available: ${SUITES.map((s) => s[0]).join(', ')}`);
  process.exit(1);
}

for (const [name, load] of selected) {
  try {
    const mod = await load();
    await mod.default();
  } catch (err) {
    // A suite that throws on import or blows up mid-run is itself a failure —
    // report it and keep going, so one broken file doesn't hide the rest.
    console.log(`\n${name}`);
    console.log(`  FAIL  suite crashed  — ${err.constructor.name}: ${err.message}`);
    console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    process.exitCode = 1;
  }
}

process.exit(report() > 0 ? 1 : process.exitCode || 0);
