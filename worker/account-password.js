/**
 * Customer passwords: the rules, the hash, the check.
 *
 * PBKDF2-SHA256 through WebCrypto, the one slow hash the Workers runtime has
 * built in. 50,000 rounds is what fits: it costs about 6ms of CPU, and a free
 * Workers plan allows 10ms a request, so this leaves room for the rest of the
 * request. The runtime will not go past 100,000 in any case.
 *
 * What makes up for the round count is the pepper. The PBKDF2 output is put
 * through HMAC with ACCOUNT_SECRET, a Worker secret that never sits in KV. A
 * copy of the ACCOUNTS namespace on its own is a pile of hashes that cannot be
 * tested against a guess, because the key to test them with is not in it.
 *
 * Stored as `pbkdf2-sha256$<rounds>$<salt>$<hash>`, so the rounds can be
 * raised later without breaking a single account: a sign-in on an older hash
 * is re-hashed at the new count (see needsRehash).
 */

export const ROUNDS = 50000;
export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;

const enc = new TextEncoder();

function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** The handful nobody should be allowed, checked without case. */
const TOO_COMMON = new Set([
  'password', 'password1', 'password12', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'qwerty123', '11111111', '00000000', 'iloveyou', 'firefighter', 'firefighter1',
  'rawhidecity', 'rawhidecityleather', 'letmein1', 'abcd1234', 'baseball', 'football',
]);

export class PasswordError extends Error {
  constructor(message, field = 'password') {
    super(message);
    this.field = field;
  }
}

/**
 * Length is the rule that counts: 8 or more, nothing about symbols or capitals.
 * The password can't be the email, one character over and over, or one of the
 * few that everybody tries first.
 */
export function readPassword(value, { email = '', field = 'password' } = {}) {
  const password = typeof value === 'string' ? value : '';
  if (!password) throw new PasswordError('Pick a password.', field);
  if (password.length < MIN_LENGTH) throw new PasswordError(`Password has to be at least ${MIN_LENGTH} characters.`, field);
  if (password.length > MAX_LENGTH) throw new PasswordError(`Password can be ${MAX_LENGTH} characters at most.`, field);
  const lower = password.toLowerCase();
  if (/^(.)\1+$/.test(password) || TOO_COMMON.has(lower)) {
    throw new PasswordError('That password is too easy to guess. Pick another.', field);
  }
  if (email && (lower === email.toLowerCase() || lower === email.toLowerCase().split('@')[0])) {
    throw new PasswordError("Don't use your email as your password.", field);
  }
  return password;
}

async function derive(password, salt, rounds, pepper) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, 256);
  const mac = await crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', mac, bits));
}

export async function hashPassword(env, password, rounds = ROUNDS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, rounds, env.ACCOUNT_SECRET);
  return `pbkdf2-sha256$${rounds}$${b64(salt)}$${b64(hash)}`;
}

/** True when the password matches the stored hash. Never throws. */
export async function checkPassword(env, password, stored) {
  try {
    const [scheme, rounds, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'pbkdf2-sha256' || !salt || !hash) return false;
    const n = Number(rounds);
    if (!Number.isInteger(n) || n < 1000 || n > 100000) return false;
    const want = unb64(hash);
    const got = await derive(String(password || ''), unb64(salt), n, env.ACCOUNT_SECRET);
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
    return diff === 0;
  } catch {
    return false;
  }
}

export function needsRehash(stored) {
  return Number(String(stored || '').split('$')[1]) < ROUNDS;
}

/**
 * A sign-in for an email with no account still costs one hash, so how long
 * the answer takes doesn't say whether the account exists.
 */
const DUMMY = `pbkdf2-sha256$${ROUNDS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
export async function burnOneHash(env) {
  await checkPassword(env, 'not-a-real-password', DUMMY);
}
