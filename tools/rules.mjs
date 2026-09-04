/**
 * Source for `database.rules.json` — run `npm run rules` to regenerate it.
 *
 * The rules file itself takes no comment keys (a `"//"` child is read as a path
 * and rejected) and these expressions are far too long to hand-write as JSON,
 * so the rules are assembled here from named helpers instead.
 *
 * What they are for: a ship's position never travels over the wire and the
 * database is the only party that knows both of them, so a player with the
 * console open can neither read where the enemy is nor write a position, a hit
 * or a ram that isn't true. Every claim a client makes about a ship is checked
 * here, against data that client cannot read.
 *
 *   sessions/{n}                    public, readable by any signed-in device
 *     createdAt hostAt joinerAt joined terminated    presence and rule 9's TTLs
 *     hostId joinerId              the two seats, each an anonymous auth uid
 *     moves/{pushKey}              the game as both devices see it
 *     craters/{round}/{x}_{y}      one record per shot; its existence = crater
 *   secrets/{n}/{round}/{seat}/{e}  SECRET: where that ship stood at epoch e
 *
 * Read rules cascade down, so the secret cannot live inside the record the
 * lobby reads wholesale — hence the separate tree, readable only by the device
 * whose seat it belongs to.
 *
 * `round` is `{createdAt}_{key}`, where key is the push key of the `reset`
 * entry that opened the round (`0` for the first one). Two halves, two jobs:
 * the reset key gives a rematch a fresh namespace with no counter to race over,
 * and `createdAt` keeps a recycled game number from landing on the leftovers of
 * whoever held it last. An epoch is a position in one ship's life: 0 is where
 * it was placed and every move after that is the next one. Positions are
 * written once and never again, so a ship cannot be moved out from under a shot
 * that has already been fired at it.
 *
 * Every action is two writes, and that is what keeps validation from becoming
 * an oracle: a rejected write tells the writer something, so the action commits
 * first (the crater record for a shot, the new position for a move) and only
 * then writes the log entry carrying the answer — `hit` or `ram` — which these
 * rules check against the secret. A cheater may guess that answer and be
 * rejected, but only after the shot or the move it belongs to is already spent.
 */

import { writeFileSync } from 'node:fs';

/** Board (kept in step with BOARD_W / BOARD_H in game.service.ts). */
const W = 4;
const H = 5;

/** Rule 9.2's link lifetimes, in ms — the same numbers as lobby-registry. */
const STALE_UNOCCUPIED_MS = 10 * 60_000;
const STALE_OCCUPIED_MS = 3 * 60 * 60_000;

const and = (...parts) => parts.filter(Boolean).join(' && ');
const or = (...parts) => `(${parts.filter(Boolean).join(' || ')})`;

// ---------------------------------------------------------------- expressions

/** `sessions/{n}/` as a rules expression fragment. */
const S = "'sessions/' + $n + '/'";
const HOST_ID = `root.child(${S} + 'hostId').val()`;
const JOINER_ID = `root.child(${S} + 'joinerId').val()`;
/** The seat the writer holds: 0 for the host, 1 for the joiner. */
const MY_SEAT = `(${HOST_ID} == auth.uid ? 0 : 1)`;
/** …and whether they hold one at all. Strangers cannot write to a live game. */
const SEATED = `(auth != null && (${HOST_ID} == auth.uid || ${JOINER_ID} == auth.uid))`;

/** A field of the node a rule is anchored on (or of its parent). */
const f = (d, name) => `${d}.child('${name}').val()`;
const seatOf = (d) => f(d, 'p');
const foeOf = (d) => `(${f(d, 'p')} == 0 ? 1 : 0)`;
const foeSeat = (seat) => `(${seat} == 0 ? 1 : 0)`;

/** `secrets/{n}/{round}/{seat}/{epoch}` — the ship itself. */
const shipIn = (round, seat, epoch) =>
  `root.child('secrets/' + $n + '/' + ${round} + '/' + ${seat} + '/' + ${epoch})`;
/** `craters/{round}/{x}_{y}` — one record per shot, and every crater test. */
const craterIn = (round, x, y) =>
  `root.child(${S} + 'craters/' + ${round} + '/' + ${x} + '_' + ${y})`;

/** That ship stood on exactly this square at that epoch. */
const shipOn = (round, seat, epoch, x, y) =>
  and(
    `${shipIn(round, seat, epoch)}.child('x').val() == ${x}`,
    `${shipIn(round, seat, epoch)}.child('y').val() == ${y}`,
  );

/** The epoch a ship is living in right now: written, with nothing after it. */
const isCurrent = (round, seat, epoch) =>
  and(`${shipIn(round, seat, epoch)}.exists()`, `!${shipIn(round, seat, `${epoch} + 1`)}.exists()`);

/**
 * Rule 5.4's exception: a ship whose eight bordering squares are all craters or
 * off the board has nowhere to go, so it fires and stays put. Only then may a
 * player skip their move — otherwise standing still while the log says they
 * sailed would quietly break the deduction the whole game is played on.
 */
function boxedIn(round, seat, epoch) {
  const px = `${shipIn(round, seat, epoch)}.child('x').val()`;
  const py = `${shipIn(round, seat, epoch)}.child('y').val()`;
  const clauses = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = dx === 0 ? px : `(${px} ${dx < 0 ? '-' : '+'} 1)`;
      const ny = dy === 0 ? py : `(${py} ${dy < 0 ? '-' : '+'} 1)`;
      clauses.push(
        or(
          ...(dx < 0 ? [`${px} < 1`] : dx > 0 ? [`${px} > ${W - 2}`] : []),
          ...(dy < 0 ? [`${py} < 1`] : dy > 0 ? [`${py} > ${H - 2}`] : []),
          `${craterIn(round, nx, ny)}.exists()`,
        ),
      );
    }
  }
  return and(...clauses);
}

// --------------------------------------------------------------- the log entry

const n = 'newData';
const p = 'newData.parent()';
/** The round an entry belongs to, and the ship it talks about. */
const rOf = (d) => f(d, 'r');
const myShip = (d) => shipIn(rOf(d), seatOf(d), f(d, 'e'));

/**
 * A ram comes with the square both wrecks end up on, and an ordinary move
 * comes with no square at all — not even the writer's own. Leaving it out is
 * the anti-cheat: an entry that carried where its ship went would hand the
 * opponent everything the secret exists to keep, so the rules refuse one.
 */
const ramReveal = or(
  and(`${f(n, 'ram')} == true`, `newData.hasChildren(['x', 'y'])`),
  and(`${f(n, 'ram')} == false`, `!newData.hasChild('x')`, `!newData.hasChild('y')`),
);

/**
 * Which fields each kind of entry must carry. A field nobody validates is a
 * field a cheater can leave out, so the shape is pinned here and the meaning of
 * each field by its own rule further down.
 */
const ENTRY_SHAPE = or(
  `${f(n, 'k')} == 'reset'`,
  and(
    `${f(n, 'k')} == 'place'`,
    `newData.hasChildren(['e', 'ram'])`,
    `${f(n, 'e')} == 0`,
    ramReveal,
  ),
  and(`${f(n, 'k')} == 'fire'`, `newData.hasChildren(['e', 'te', 'x', 'y', 'fx', 'fy', 'hit'])`),
  and(
    `${f(n, 'k')} == 'move'`,
    `newData.hasChildren(['e', 'oe', 'ram'])`,
    `${f(n, 'e')} >= 1`,
    ramReveal,
  ),
  and(`${f(n, 'k')} == 'stay'`, `newData.hasChildren(['e'])`),
  and(`${f(n, 'k')} == 'reveal'`, `newData.hasChildren(['e', 'x', 'y'])`),
);

/**
 * The entry has to match the ship it talks about. Placement, a move, a skipped
 * move and a reveal all name an epoch that must actually have been written; a
 * shot has to match the crater record that committed it, so the square, both
 * epochs and the shooter were all fixed before the answer was known.
 */
const ENTRY_MEANING = or(
  `${f(n, 'k')} == 'reset'`,
  and(
    or(`${f(n, 'k')} == 'place'`, `${f(n, 'k')} == 'move'`, `${f(n, 'k')} == 'reveal'`),
    `${myShip(n)}.exists()`,
  ),
  and(
    `${f(n, 'k')} == 'stay'`,
    isCurrent(rOf(n), seatOf(n), f(n, 'e')),
    boxedIn(rOf(n), seatOf(n), f(n, 'e')),
  ),
  and(
    `${f(n, 'k')} == 'fire'`,
    `${craterIn(rOf(n), f(n, 'x'), f(n, 'y'))}.child('by').val() == ${f(n, 'p')}`,
    `${craterIn(rOf(n), f(n, 'x'), f(n, 'y'))}.child('e').val() == ${f(n, 'e')}`,
    `${craterIn(rOf(n), f(n, 'x'), f(n, 'y'))}.child('te').val() == ${f(n, 'te')}`,
  ),
);

/**
 * Rule 6.2, and the one thing a losing player would most like to lie about:
 * `hit` is true exactly when the enemy's committed position for the epoch the
 * shot was aimed at is the square it landed on. The shooter has to guess it —
 * they cannot read the enemy's square — but the shot is already spent by then,
 * so a wrong guess costs a round trip and tells them only what the shot was
 * about to tell them anyway.
 */
const HIT_RULE = and(
  'newData.isBoolean()',
  `newData.val() == (${shipOn(rOf(p), foeOf(p), f(p, 'te'), f(p, 'x'), f(p, 'y'))})`,
);

/**
 * Rule 11: sailing onto the other ship. Same shape as `hit` — the mover cannot
 * see the square they are sailing into, and their new position is already
 * written by the time they claim what they found there. At placement the enemy
 * is at epoch 0 by definition (rule 11.5); afterwards the entry names the epoch
 * the enemy is living in, which must be their current one.
 */
const ramTruth = (epoch) =>
  `(${and(
    `${shipIn(rOf(p), foeOf(p), epoch)}.exists()`,
    shipOn(
      rOf(p),
      foeOf(p),
      epoch,
      `${myShip(p)}.child('x').val()`,
      `${myShip(p)}.child('y').val()`,
    ),
  )})`;

const RAM_RULE = and(
  'newData.isBoolean()',
  or(
    and(`${f(p, 'k')} == 'place'`, `newData.val() == ${ramTruth('0')}`),
    and(
      `${f(p, 'k')} == 'move'`,
      isCurrent(rOf(p), foeOf(p), f(p, 'oe')),
      `newData.val() == ${ramTruth(f(p, 'oe'))}`,
    ),
  ),
);

/**
 * `x`/`y` are the bombed square on a shot, pinned by the crater record; on
 * every other kind of entry they are a reveal of the writer's own ship (a ram,
 * or the wreck at the end of a round) and must match where it is standing.
 */
const coordRule = (axis, max) =>
  and(
    'newData.isNumber()',
    'newData.val() >= 0',
    `newData.val() <= ${max}`,
    or(`${f(p, 'k')} == 'fire'`, `newData.val() == ${myShip(p)}.child('${axis}').val()`),
  );

/** Rule 5.2: a shot is fired from the square the shooter is actually on. */
const fromRule = (axis, max) =>
  and(
    'newData.isNumber()',
    'newData.val() >= 0',
    `newData.val() <= ${max}`,
    `newData.val() == ${myShip(p)}.child('${axis}').val()`,
  );

const epochField = `newData.isNumber() && newData.val() >= 0 && newData.val() <= 999`;

const moves = {
  $key: {
    // Append-only: an entry is complete when it lands and nobody edits it
    // afterwards. A shot may be logged by either device, because the crater
    // record already fixed everything about it — that way a shooter who dies
    // between its two writes leaves a game the other player can unstick.
    '.write': and(
      SEATED,
      '!data.exists()',
      or(
        `${f(n, 'p')} == ${MY_SEAT}`,
        and(
          `${f(n, 'k')} == 'fire'`,
          `${craterIn(rOf(n), f(n, 'x'), f(n, 'y'))}.child('by').val() == ${f(n, 'p')}`,
        ),
      ),
    ),
    '.validate': and(`newData.hasChildren(['p', 'k', 'r'])`, ENTRY_SHAPE, ENTRY_MEANING),
    p: { '.validate': or('newData.val() == 0', 'newData.val() == 1') },
    k: { '.validate': `newData.val().matches(/^(place|fire|move|stay|reveal|reset)$/)` },
    r: { '.validate': `newData.isString() && newData.val().length <= 48` },
    e: { '.validate': epochField },
    te: { '.validate': epochField },
    oe: { '.validate': epochField },
    x: { '.validate': coordRule('x', W - 1) },
    y: { '.validate': coordRule('y', H - 1) },
    fx: { '.validate': fromRule('x', W - 1) },
    fy: { '.validate': fromRule('y', H - 1) },
    hit: { '.validate': HIT_RULE },
    ram: { '.validate': RAM_RULE },
    $otherMoveField: { '.validate': false },
  },
};

/**
 * The shot itself, committed before its answer is known. One record per square
 * (rule 5.3: a square is bombed once and is dead water for both ships after
 * that), and its existence is what every "is that a crater?" test above reads.
 */
const craters = {
  $r: {
    $sq: {
      '.write': and(SEATED, '!data.exists()'),
      '.validate': and(
        `newData.hasChildren(['by', 'e', 'te', 'x', 'y'])`,
        `$sq == ${f(n, 'x')} + '_' + ${f(n, 'y')}`,
        `${f(n, 'by')} == ${MY_SEAT}`,
        // You fire from where you are, at where they are: both ships must be
        // living in the epoch the shot names, so neither side can aim at — or
        // answer for — a position that has already been left behind.
        isCurrent('$r', f(n, 'by'), f(n, 'e')),
        isCurrent('$r', foeSeat(f(n, 'by')), f(n, 'te')),
        // Rule 2.3: one board — you cannot bomb the square under your own keel.
        `!(${shipOn('$r', f(n, 'by'), f(n, 'e'), f(n, 'x'), f(n, 'y'))})`,
      ),
      by: { '.validate': or('newData.val() == 0', 'newData.val() == 1') },
      e: { '.validate': epochField },
      te: { '.validate': epochField },
      x: { '.validate': `newData.isNumber() && newData.val() >= 0 && newData.val() <= ${W - 1}` },
      y: { '.validate': `newData.isNumber() && newData.val() >= 0 && newData.val() <= ${H - 1}` },
      $otherCraterField: { '.validate': false },
    },
  },
};

// ------------------------------------------------------------------ the secret

/** This ship's own previous square — the one it must have sailed from. */
const prev = `root.child('secrets/' + $n + '/' + $round + '/' + $seat + '/' + (${f(n, 'e')} - 1))`;
const step = (axis) => `(${f(n, axis)} - ${prev}.child('${axis}').val())`;
const OWNS_SEAT = `auth != null && auth.uid == root.child(${S} + ($seat == '0' ? 'hostId' : 'joinerId')).val()`;

const secrets = {
  $n: {
    $round: {
      $seat: {
        // Only the device holding the seat may ever read this, and only its own
        // ship. That is the whole exercise: the other player's device is never
        // told where the ship is, so there is nothing in it to inspect.
        '.read': OWNS_SEAT,
        $e: {
          // Write-once: where a ship stood is settled the moment it stands
          // there, so no shot can ever be dodged after the fact.
          '.write': and(OWNS_SEAT, '!data.exists()'),
          '.validate': and(
            `newData.hasChildren(['x', 'y', 'e'])`,
            `$e == ${f(n, 'e')} + ''`,
            // Rule 5.3: a crater is dead water — no ship may sail onto one.
            `!${craterIn('$round', f(n, 'x'), f(n, 'y'))}.exists()`,
            or(
              `${f(n, 'e')} == 0`,
              // Rule 3: one square, in any of the eight directions. The
              // previous position is immutable, so a course is checked step by
              // step and a ship can never appear where it could not have sailed.
              and(
                `${prev}.exists()`,
                `${step('x')} >= -1`,
                `${step('x')} <= 1`,
                `${step('y')} >= -1`,
                `${step('y')} <= 1`,
                or(`${step('x')} != 0`, `${step('y')} != 0`),
              ),
            ),
          ),
          x: {
            '.validate': `newData.isNumber() && newData.val() >= 0 && newData.val() <= ${W - 1}`,
          },
          y: {
            '.validate': `newData.isNumber() && newData.val() >= 0 && newData.val() <= ${H - 1}`,
          },
          e: { '.validate': epochField },
          $otherShipField: { '.validate': false },
        },
      },
    },
  },
};

// -------------------------------------------------------------- the record

/** Rule 9.2: the link is free to claim again once it has aged out. */
const staleFor = (ms) =>
  and(
    `now - data.child('createdAt').val() > ${ms}`,
    or(`!data.child('hostAt').exists()`, `now - data.child('hostAt').val() > ${ms}`),
    or(`!data.child('joinerAt').exists()`, `now - data.child('joinerAt').val() > ${ms}`),
  );

const EXPIRED = or(
  '!data.exists()',
  and(
    `data.child('terminated').val() != true`,
    or(
      and(`data.child('joined').val() == true`, staleFor(STALE_OCCUPIED_MS)),
      and(`data.child('joined').val() != true`, staleFor(STALE_UNOCCUPIED_MS)),
    ),
  ),
);

/** Only a player holding a seat can end the link for both of them (rule 9). */
const MINE = `(auth != null && (auth.uid == data.child('hostId').val() || auth.uid == data.child('joinerId').val()))`;

const rules = {
  rules: {
    sessions: {
      $n: {
        '.read': 'auth != null',
        // Claiming a free (or long-dead) number writes the whole record; after
        // that it only ever changes through the children below, so nobody can
        // overwrite a game in progress — or somebody else's seat.
        '.write': `auth != null && (newData.val() == null ? ${MINE} : ${EXPIRED})`,
        '.validate': `$n.matches(/^[0-9]{1,4}$/)`,
        createdAt: { '.validate': 'newData.isNumber() && newData.val() <= now' },
        hostAt: {
          '.write': `auth != null && auth.uid == newData.parent().child('hostId').val()`,
          '.validate': 'newData.isNumber() && newData.val() <= now',
        },
        joinerAt: {
          '.write': `auth != null && auth.uid == newData.parent().child('joinerId').val()`,
          '.validate': 'newData.isNumber() && newData.val() <= now',
        },
        joined: {
          '.write': `auth != null && newData.val() == true`,
          '.validate': `newData.isBoolean() && (data.val() != true || newData.val() == true)`,
        },
        terminated: {
          '.write': MINE,
          '.validate': `newData.isBoolean() && (data.val() != true || newData.val() == true)`,
        },
        // A seat is an anonymous auth uid, taken once and never reassigned: it
        // is what every rule above means by "the player whose ship this is".
        hostId: { '.validate': `newData.isString() && newData.val() == auth.uid` },
        joinerId: {
          '.write': `auth != null && !data.exists()`,
          '.validate': `newData.isString() && newData.val() == auth.uid && ${HOST_ID} != auth.uid`,
        },
        moves,
        craters,
        $other: { '.validate': false },
      },
    },
    secrets,
    stats: {
      '.read': true,
      $metric: {
        '.write': 'auth != null',
        '.validate': `$metric.matches(/^[a-zA-Z]{1,24}$/) && newData.isNumber() && (!data.exists() || newData.val() > data.val())`,
      },
    },
  },
};

writeFileSync(
  new URL('../database.rules.json', import.meta.url),
  JSON.stringify(rules, null, 2) + '\n',
);
console.log('database.rules.json written');
