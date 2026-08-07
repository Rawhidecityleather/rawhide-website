/**
 * A hundred lines of test runner is a hundred lines nobody maintains. This is
 * the whole harness: count what passed, print what didn't, exit non-zero.
 *
 * No dependencies and no install step — `node worker/tests/run.mjs` is the
 * entire setup, which is the only reason these will still get run in a year.
 */

const results = [];
let current = 'general';

export function suite(name) {
  current = name;
  console.log(`\n${name}`);
}

/**
 * `value` is either a boolean or a function returning one. Pass a function
 * when the code under test might throw — a crash is a failure with a message,
 * not an aborted run that hides every check after it.
 */
export function check(label, value, note = '') {
  let ok = false;
  let detail = note;

  if (typeof value === 'function') {
    try {
      ok = value() === true;
    } catch (err) {
      detail = `${err.constructor.name}: ${err.message}`;
    }
  } else {
    ok = value === true;
  }

  results.push({ suite: current, label, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  return ok;
}

/** Asserts the thing actually blows up, and blows up the way it should. */
export function throws(label, fn, match) {
  let message = '';
  try {
    fn();
  } catch (err) {
    message = err.message;
  }
  const ok = message && (!match || message.includes(match));
  return check(label, ok === true || !!ok, message || 'did not throw');
}

export function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);

  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  ${f.suite} — ${f.label}`);
  }
  return failed.length;
}
