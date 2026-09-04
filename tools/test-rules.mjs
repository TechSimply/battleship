/**
 * The rules, tested against the real thing.
 *
 * `npm run test:rules` boots the Realtime Database emulator with
 * `database.rules.json` and drives it over REST as three different signed-in
 * devices: the two seats and a stranger. Everything the anti-cheat rests on is
 * asserted here, because it is not asserted anywhere else — the client-side
 * tests can only show that the app plays by the rules, never that the database
 * makes it. It also catches a rules file that fails to *parse*, which is how a
 * deploy can otherwise take the game down.
 *
 * Requires Java (the emulator is a jar).
 */

const HOST = process.env.RULES_EMULATOR ?? '127.0.0.1:9000';
const NS = 'battleship-p2p-default-rtdb';

/** An emulator-accepted token: it parses the JWT and never checks a signature. */
function token(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${NS}`,
    sub: uid,
    user_id: uid,
    iat: now,
    exp: now + 3600,
    auth_time: now,
    provider_id: 'anonymous',
    firebase: { sign_in_provider: 'anonymous', identities: {} },
  })}.`;
}

const url = (path, uid) =>
  `http://${HOST}/${path}.json?ns=${NS}${uid ? `&auth=${token(uid)}` : ''}`;

const req = async (method, path, uid, body) => {
  const res = await fetch(url(path, uid), {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
};

const put = (path, uid, body) => req('PUT', path, uid, body);
/** What the client's `update()` does: several children of one node, at once. */
const patch = (path, uid, body) => req('PATCH', path, uid, body);
const post = (path, uid, body) => req('POST', path, uid, body);
const get = (path, uid) => req('GET', path, uid);
const del = (path, uid) => req('DELETE', path, uid);

let passed = 0;
const failures = [];

async function allow(what, promise) {
  const res = await promise;
  if (res.ok) passed++;
  else failures.push(`${what}: expected to be allowed, got ${res.status} ${res.body.trim()}`);
  return res;
}

async function deny(what, promise) {
  const res = await promise;
  if (!res.ok) passed++;
  else failures.push(`${what}: expected to be REJECTED, but it was accepted`);
  return res;
}

// Seats: H hosts, J joins, X is a stranger who guessed the number.
const H = 'uid-host';
const J = 'uid-joiner';
const X = 'uid-stranger';

const N = 1234;
const sess = `sessions/${N}`;
const at = Date.now();
const R = `${at}_0`;
const ship = (n, seat, e) => `secrets/${N}/${R}/${seat}/${e}`;
const crater = (x, y) => `${sess}/craters/${R}/${x}_${y}`;

async function main() {
  // A clean slate, as the owner (the emulator's back door).
  await fetch(`http://${HOST}/.json?ns=${NS}`, { method: 'DELETE' });

  // ---------------------------------------------------------------- the lobby
  await allow(
    'host claims a free number',
    put(sess, H, {
      createdAt: at,
      hostAt: at,
      joinerAt: null,
      joined: false,
      terminated: false,
      hostId: H,
    }),
  );
  await deny(
    'a stranger cannot overwrite a live record',
    put(sess, X, { createdAt: at, hostAt: at, joined: false, terminated: false, hostId: X }),
  );
  await deny('a stranger cannot take a seat that is not theirs', put(`${sess}/hostId`, X, X));
  await deny('nobody can claim a seat under another uid', put(`${sess}/joinerId`, J, X));
  // Exactly what takeJoinerSeat() writes, in the one update it writes it in:
  // the presence stamp is only allowed because the seat lands with it.
  await deny(
    'a stranger cannot take the seat by writing somebody else into it',
    patch(sess, X, { joinerAt: Date.now(), joined: true, joinerId: J }),
  );
  await allow(
    'the joiner takes the free seat',
    patch(sess, J, { joinerAt: Date.now(), joined: true, joinerId: J }),
  );
  await deny('a stranger cannot take a seat that is taken', put(`${sess}/joinerId`, X, X));
  await allow('…and heartbeats into it', patch(sess, J, { joinerAt: Date.now() }));
  await deny(
    'a player cannot beat the other one’s presence',
    patch(sess, J, { hostAt: Date.now() }),
  );
  await allow('the host heartbeats into its own', patch(sess, H, { hostAt: Date.now() }));
  await deny('a stranger cannot end the link', del(sess, X));

  // -------------------------------------------------------------- the secret
  await allow('the host places its ship', put(ship(N, 0, 0), H, { x: 1, y: 1, e: 0 }));
  await allow('the joiner places its ship', put(ship(N, 1, 0), J, { x: 3, y: 4, e: 0 }));

  await deny('the joiner cannot read where the host is', get(ship(N, 0, 0), J));
  await deny('a stranger cannot read either ship', get(ship(N, 0, 0), X));
  await deny('nor can an unauthenticated client', get(ship(N, 0, 0)));
  await deny('nor can anyone read the whole secret tree', get(`secrets/${N}`, J));
  const own = await allow('a player can read its own ship back', get(ship(N, 0, 0), H));
  if (own.ok && !own.body.includes('"x":1')) failures.push('own ship read back wrong');

  await deny(
    'a player cannot write the other one’s ship',
    put(ship(N, 1, 1), H, { x: 3, y: 3, e: 1 }),
  );
  await deny(
    'a position is written once and never again',
    put(ship(N, 0, 0), H, { x: 2, y: 2, e: 0 }),
  );
  await deny('the epoch must match its own key', put(ship(N, 0, 5), H, { x: 1, y: 2, e: 1 }));
  await deny('a ship cannot teleport', put(ship(N, 0, 1), H, { x: 3, y: 3, e: 1 }));
  await deny(
    'a ship cannot stand still and call it a move',
    put(ship(N, 0, 1), H, { x: 1, y: 1, e: 1 }),
  );
  await deny('a ship cannot sail off the board', put(ship(N, 0, 1), H, { x: 4, y: 1, e: 1 }));
  await deny('an epoch cannot be skipped', put(ship(N, 0, 2), H, { x: 1, y: 2, e: 2 }));

  // --------------------------------------------------------------- placement
  await deny(
    'a placement cannot be logged for the other player',
    post(`${sess}/moves`, J, { p: 0, k: 'place', r: R, e: 0, ram: false }),
  );
  await deny(
    'a placement cannot claim a ram that did not happen',
    post(`${sess}/moves`, H, { p: 0, k: 'place', r: R, e: 0, ram: true, x: 1, y: 1 }),
  );
  await deny(
    'a placement cannot smuggle its own square into the log',
    post(`${sess}/moves`, H, { p: 0, k: 'place', r: R, e: 0, ram: false, x: 1, y: 1 }),
  );
  await allow(
    'the host logs its placement',
    post(`${sess}/moves`, H, { p: 0, k: 'place', r: R, e: 0, ram: false }),
  );
  await allow(
    'the joiner logs its placement',
    post(`${sess}/moves`, J, { p: 1, k: 'place', r: R, e: 0, ram: false }),
  );

  // -------------------------------------------------------------------- fire
  // The host is on 1,1 and the joiner on 3,4. The host fires at 3,4 — a hit it
  // has no way of knowing about until the database tells it.
  await deny(
    'a shot cannot be logged without the crater that commits it',
    post(`${sess}/moves`, H, {
      p: 0,
      k: 'fire',
      r: R,
      e: 0,
      te: 0,
      x: 3,
      y: 4,
      fx: 1,
      fy: 1,
      hit: true,
    }),
  );
  await deny(
    'a shot cannot be attributed to the other player',
    put(crater(3, 4), J, { by: 0, e: 0, te: 0, x: 3, y: 4 }),
  );
  await deny(
    'a shot cannot name a square other than its own key',
    put(crater(3, 4), H, { by: 0, e: 0, te: 0, x: 2, y: 4 }),
  );
  await deny(
    'a shot cannot be aimed at a stale epoch',
    put(crater(3, 4), H, { by: 0, e: 0, te: 1, x: 3, y: 4 }),
  );
  await deny(
    'a shot cannot be fired from under your own keel',
    put(crater(1, 1), H, { by: 0, e: 0, te: 0, x: 1, y: 1 }),
  );
  await allow(
    'the host commits its shot',
    put(crater(3, 4), H, { by: 0, e: 0, te: 0, x: 3, y: 4 }),
  );
  await deny(
    'a square is only bombed once',
    put(crater(3, 4), J, { by: 1, e: 0, te: 0, x: 3, y: 4 }),
  );

  await deny(
    'the shooter cannot call a hit a miss',
    post(`${sess}/moves`, H, {
      p: 0,
      k: 'fire',
      r: R,
      e: 0,
      te: 0,
      x: 3,
      y: 4,
      fx: 1,
      fy: 1,
      hit: false,
    }),
  );
  await deny(
    'the shooter cannot lie about where it fired from',
    post(`${sess}/moves`, H, {
      p: 0,
      k: 'fire',
      r: R,
      e: 0,
      te: 0,
      x: 3,
      y: 4,
      fx: 2,
      fy: 2,
      hit: true,
    }),
  );
  await allow(
    'the truth about the shot goes in the log',
    post(`${sess}/moves`, H, {
      p: 0,
      k: 'fire',
      r: R,
      e: 0,
      te: 0,
      x: 3,
      y: 4,
      fx: 1,
      fy: 1,
      hit: true,
    }),
  );

  // -------------------------------------------------------------------- move
  await deny('a ship cannot sail onto a crater', put(ship(N, 1, 1), J, { x: 3, y: 4, e: 1 }));
  await allow('the host sails on', put(ship(N, 0, 1), H, { x: 2, y: 2, e: 1 }));
  await deny(
    'a move cannot claim a ram that did not happen',
    post(`${sess}/moves`, H, { p: 0, k: 'move', r: R, e: 1, oe: 0, ram: true, x: 2, y: 2 }),
  );
  await deny(
    'a move cannot be logged for a position that was never written',
    post(`${sess}/moves`, H, { p: 0, k: 'move', r: R, e: 2, oe: 0, ram: false }),
  );
  await deny(
    'a move cannot smuggle the square it sailed to into the log',
    post(`${sess}/moves`, H, { p: 0, k: 'move', r: R, e: 1, oe: 0, ram: false, x: 2, y: 2 }),
  );
  await allow(
    'the host logs its move',
    post(`${sess}/moves`, H, { p: 0, k: 'move', r: R, e: 1, oe: 0, ram: false }),
  );
  await deny(
    'a player who can move cannot claim to be boxed in',
    post(`${sess}/moves`, H, { p: 0, k: 'stay', r: R, e: 1 }),
  );
  await deny(
    'a reveal cannot show a square the ship is not on',
    post(`${sess}/moves`, H, { p: 0, k: 'reveal', r: R, e: 1, x: 3, y: 3 }),
  );
  await allow(
    'a player may reveal its own wreck',
    post(`${sess}/moves`, H, { p: 0, k: 'reveal', r: R, e: 1, x: 2, y: 2 }),
  );

  // --------------------------------------------------------------------- ram
  // The joiner sails onto the host's square: both go down (rule 11), and the
  // database is what confirms it. It comes off its own crater (rule 5.3 stops a
  // ship sailing *onto* one, never off it) by way of 2,3.
  await allow('the joiner comes about', put(ship(N, 1, 1), J, { x: 2, y: 3, e: 1 }));
  await allow(
    'the joiner logs it',
    post(`${sess}/moves`, J, { p: 1, k: 'move', r: R, e: 1, oe: 1, ram: false }),
  );
  await allow('the joiner sails into the host', put(ship(N, 1, 2), J, { x: 2, y: 2, e: 2 }));
  await deny(
    'a ram cannot be denied',
    post(`${sess}/moves`, J, { p: 1, k: 'move', r: R, e: 2, oe: 1, ram: false }),
  );
  await allow(
    'a ram is logged as one',
    post(`${sess}/moves`, J, { p: 1, k: 'move', r: R, e: 2, oe: 1, ram: true, x: 2, y: 2 }),
  );

  // ------------------------------------------------------------- the strays
  await deny(
    'a stranger cannot write to the log',
    post(`${sess}/moves`, X, { p: 0, k: 'reset', r: R }),
  );
  await deny(
    'an unknown field cannot ride along',
    post(`${sess}/moves`, H, { p: 0, k: 'reset', r: R, hax: 1 }),
  );
  await deny(
    'an unknown kind of entry is not a move',
    post(`${sess}/moves`, H, { p: 0, k: 'win', r: R }),
  );
  await allow(
    'either player may call for a rematch',
    post(`${sess}/moves`, H, { p: 0, k: 'reset', r: R }),
  );
  await allow('a player may end the link', del(sess, J));

  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
