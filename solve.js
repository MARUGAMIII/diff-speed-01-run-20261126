// Fast drop-in for makefun-diff 1.0.0 (make.fun's own line diff).
//
// Written from scratch from the rule in the house baseline's header: lines are
// cut after every "\n"; the common prefix is kept, then the common suffix of
// what is left; between them Myers's greedy search keeps, on each diagonal,
// the path reaching furthest into the old text and, on a tie, the deletion's
// path (jsdiff takes the insertion's); no edge diagonal is pruned; the first
// path to reach both ends is the script. The patch is then built exactly as
// makefun-diff builds it (3 kept lines of context, runs at most 6 kept lines
// apart share a hunk, deletions before insertions, "%" after a line with no
// trailing newline).
//
// Speed comes from: lines hashed to small integers once (so the search compares
// ints, not strings); the search kept in 16-bit "V" rows, one per edit depth,
// reused across cases as scratch, with the previous row's insertion candidate
// carried into the next diagonal instead of re-read; the script recovered by
// backtracking through those rows instead of by carrying a linked path object
// per step the way the reference does; and the search's snakes run against
// sentinel-padded line arrays, so they need no bounds checks. (A 32-bit path
// with the same code covers inputs too large for 16-bit ids or coordinates.)

const KEEP = 0;
const DEL = 1;
const INS = 2;

/** The widest value a 16-bit row or line array can hold. */
const U16_MAX = 65535;

/** V rows, one typed array per edit depth, reused across cases as scratch. */
const vCache16 = [];
const vCache32 = [];

/**
 * The V row for edit depth d: length 2*d+5, diagonal k at index k+d+2, every
 * slot NO (no path) unless the search wrote it. The two spare slots at each
 * end mean a read of diagonal k-1 or k+1 never runs off the row.
 */
function vRow16(d) {
  let v = vCache16[d];
  if (v === undefined) {
    v = new Uint16Array(2 * d + 5).fill(U16_MAX);
    vCache16[d] = v;
  }
  return v;
}
function vRow32(d) {
  let v = vCache32[d];
  if (v === undefined) {
    v = new Int32Array(2 * d + 5).fill(-1);
    vCache32[d] = v;
  }
  return v;
}

/**
 * The edit script of the trimmed middles a[a0..a0+n) into b[b0..b0+m), as
 * merged runs pushed into kinds/counts (in order). Mirrors the reference's
 * editRuns exactly: same tie-break, same "no candidate past either end" rule,
 * same "first path to reach both ends" stop, same snakes.
 *
 * a and b carry a sentinel just past the middle, so a snake stops there
 * without a bounds check (no line id equals either sentinel).
 */
function myersRuns(a, a0, n, b, b0, m, kinds, counts, vRow, NO) {
  if (n === 0) {
    if (m > 0) {
      kinds.push(INS);
      counts.push(m);
    }
    return;
  }
  if (m === 0) {
    kinds.push(DEL);
    counts.push(n);
    return;
  }

  // d = 0: the common run from the first lines.
  let x = 0;
  let y = 0;
  while (a[a0 + x] === b[b0 + y]) {
    x++;
    y++;
  }
  const v0 = vRow(0);
  v0[2] = x; // diagonal 0 at index 0+0+2
  if (x >= n && y >= m) {
    kinds.push(KEEP);
    counts.push(x);
    return;
  }

  let D = -1;
  const maxD = n + m;
  for (let d = 1; d <= maxD; d++) {
    const vp = vRow(d - 1);
    const vc = vRow(d);
    // j = k + d + 1 runs 1..2d+1 step 2 for k = -d..d step 2. vp's diagonal
    // k+1 sits at j+1; vc's diagonal k at j+1; the deletion candidate for
    // this k is the previous diagonal's insertion candidate, kept in prevVd.
    // (vd - j + d) is the insertion source's y, the new lines it consumed.
    let prevVd = NO;
    let done = false;
    const lim = 2 * d + 1;
    for (let j = 1; j <= lim; j += 2) {
      const vr = prevVd;
      const vd = vp[j + 1];
      prevVd = vd;
      let xx;
      if (vr !== NO && vr < n) {
        // A deletion path that stays inside the old text.
        xx = vr + 1;
        // An insertion path that stays inside the new text, and only when it
        // reaches strictly further (the tie goes to the deletion).
        if (vd !== NO && vd - j + d < m && vd > xx) xx = vd;
      } else {
        // No deletion path: the insertion, if it stays inside the new text.
        xx = vd !== NO && vd - j + d < m ? vd : NO;
      }
      if (xx === NO) {
        vc[j + 1] = NO;
        continue;
      }
      let yy = xx - j + d + 1;
      while (a[a0 + xx] === b[b0 + yy]) {
        xx++;
        yy++;
      }
      vc[j + 1] = xx;
      if (xx === n && yy === m) {
        D = d;
        done = true;
        break;
      }
    }
    if (done) break;
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Backtrack from (n, m) at depth D: the same choices the forward search
  // made, read back off the V rows. Runs are collected in reverse, merging
  // neighbours of one kind, then reversed below.
  const rk = [];
  const rc = [];
  const push = (kind, count) => {
    if (count <= 0) return;
    const last = rk.length - 1;
    if (last >= 0 && rk[last] === kind) rc[last] += count;
    else {
      rk.push(kind);
      rc.push(count);
    }
  };
  x = n;
  y = m;
  for (let d = D; d >= 1; d--) {
    const k = x - y;
    const vp = vRow(d - 1);
    const offP = d + 1;
    const vr = vp[k - 1 + offP];
    const vd = vp[k + 1 + offP];
    const delValid = vr !== NO && vr < n;
    const insValid = vd !== NO && vd - k - 1 < m;
    let preX;
    let preY;
    if (delValid && (!insValid || vr + 1 >= vd)) {
      // A deletion: the move lands one old line further on diagonal k.
      push(KEEP, x - (vr + 1));
      push(DEL, 1);
      preX = vr;
      preY = vr - (k - 1);
    } else {
      // An insertion: the move lands one new line further on diagonal k.
      push(KEEP, y - (vd - k));
      push(INS, 1);
      preX = vd;
      preY = vd - (k + 1);
    }
    x = preX;
    y = preY;
  }
  // The d = 0 run: what the first snake kept.
  push(KEEP, x);
  // Reverse into the output arrays.
  for (let i = rk.length - 1; i >= 0; i--) {
    kinds.push(rk[i]);
    counts.push(rc[i]);
  }
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldText = input.old;
  const newText = input.new;

  // Identical texts: the first line alone. (Also covers the empty pair.)
  if (oldText === newText) {
    let n = 0;
    let i = oldText.indexOf('\n');
    while (i !== -1) {
      n++;
      i = oldText.indexOf('\n', i + 1);
    }
    if (oldText.length > 0 && !oldText.endsWith('\n')) n++;
    return `makefun-diff/1 old=${n} new=${n} hunks=0 deleted=0 inserted=0\n`;
  }

  // Lines: cut after every "\n"; a last line with no "\n" is a line too.
  const op = oldText.split('\n');
  const nq = newText.split('\n');
  let n = op.length - 1;
  if (op[n] !== '') n++;
  let m = nq.length - 1;
  if (nq[m] !== '') m++;
  const oldBare = n > 0 && !oldText.endsWith('\n');
  const newBare = m > 0 && !newText.endsWith('\n');

  // Hash every line to a small integer. Lines that end in "\n" are keyed by
  // their text; a bare last line gets a fresh id, so it never equals a line
  // with the same text that does end in "\n".
  const ids = new Map();
  let nextId = 0;
  const a32 = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    if (oldBare && i === n - 1) continue;
    const s = op[i];
    let id = ids.get(s);
    if (id === undefined) {
      id = nextId++;
      ids.set(s, id);
    }
    a32[i] = id;
  }
  const b32 = new Int32Array(m + 1);
  for (let i = 0; i < m; i++) {
    if (newBare && i === m - 1) continue;
    const s = nq[i];
    let id = ids.get(s);
    if (id === undefined) {
      id = nextId++;
      ids.set(s, id);
    }
    b32[i] = id;
  }
  if (oldBare || newBare) {
    if (oldBare && newBare && op[n - 1] === nq[m - 1]) {
      a32[n - 1] = nextId;
      b32[m - 1] = nextId;
    } else {
      if (oldBare) a32[n - 1] = nextId++;
      if (newBare) b32[m - 1] = nextId++;
    }
  }

  // 16-bit line arrays and V rows when everything fits in them (line counts
  // and ids below the sentinels); the 32-bit path otherwise.
  let a;
  let b;
  let sentA;
  let sentB;
  let vRow;
  let NO;
  if (n <= U16_MAX - 1 && m <= U16_MAX - 1 && nextId <= U16_MAX - 1) {
    a = new Uint16Array(a32);
    b = new Uint16Array(b32);
    sentA = U16_MAX - 1;
    sentB = U16_MAX;
    vRow = vRow16;
    NO = U16_MAX;
  } else {
    a = a32;
    b = b32;
    sentA = -1;
    sentB = -2;
    vRow = vRow32;
    NO = -1;
  }
  a[n] = sentA;
  b[m] = sentB;

  // The common prefix, then the common suffix of what is left. The prefix
  // loop needs no bounds check: the sentinels past each text differ.
  let prefix = 0;
  while (a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  // The search's snakes stop at the sentinels just past each middle.
  const a0 = prefix;
  const b0 = prefix;
  a[a0 + (n - prefix - suffix)] = sentA;
  b[b0 + (m - prefix - suffix)] = sentB;

  // The edit script of the middle, as merged runs.
  const kinds = [];
  const counts = [];
  if (prefix > 0) {
    kinds.push(KEEP);
    counts.push(prefix);
  }
  myersRuns(a, a0, n - prefix - suffix, b, b0, m - prefix - suffix, kinds, counts, vRow, NO);
  if (suffix > 0) {
    kinds.push(KEEP);
    counts.push(suffix);
  }

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let r = 0; r < kinds.length; r++) {
    const kind = kinds[r];
    const count = counts[r];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DEL) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 6 kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h === undefined ? undefined : h[h.length - 1];
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }

  // The patch.
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  const oldLast = n - 1;
  const newLast = m - 1;
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - 3);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) {
        if (at === oldLast && oldBare) out.push('=', op[at], '\n%\n');
        else out.push('=', op[at], '\n');
      }
      for (let i = 0; i < c.dels; i++) {
        const j = c.o + i;
        if (j === oldLast && oldBare) out.push('-', op[j], '\n%\n');
        else out.push('-', op[j], '\n');
      }
      for (let i = 0; i < c.ins; i++) {
        const j = c.p + i;
        if (j === newLast && newBare) out.push('+', nq[j], '\n%\n');
        else out.push('+', nq[j], '\n');
      }
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) {
      if (at === oldLast && oldBare) out.push('=', op[at], '\n%\n');
      else out.push('=', op[at], '\n');
    }
  }
  return out.join('');
}
