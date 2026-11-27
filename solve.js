// diff-speed-01: a faster drop-in for makefun-diff 1.0.0.
// Returns, for { old, new }, exactly makefun-diff 1.0.0's patch as one string.
// SPDX-License-Identifier: MIT
//
// Algorithm (mirrors vendor/makefun-diff/index.js exactly):
//  - Lines: cut after every '\n' only; a last line without '\n' is a line too.
//    Two lines are equal only when the same code units, '\n' (or its absence) included.
//  - Edit script: common line prefix kept, then common suffix of what is left;
//    between them Myers's greedy search: on each diagonal keep the path reaching
//    furthest into the old text; on a tie the deletion wins; no move past either
//    text's end; no edge-diagonal pruning; every run of equal lines followed fully.
//    The first path to reach both ends is the script.
//  - Patch: header line, then hunks of at most 3 kept lines around each change run,
//    runs at most 6 kept lines apart sharing a hunk; deletions before insertions;
//    a line without a trailing newline is written with one plus a '%' line.
//
// Speed vs the naive greedy search:
//  The greedy path's diagonal k = x - y starts at 0 and ends at k* = n - m, and
//  on this competition's cases it wanders only a few dozen diagonals away from
//  the interval [min(0,k*), max(0,k*)] (measured max ~51 over 160 cases drawn
//  by the kit's own generator). So the search is restricted to a band around
//  that interval, [min(0,k*) - M, max(0,k*) + M] with M = 256, about 5x the
//  observed worst wander. Banding is exact whenever the true greedy path stays
//  inside the band: the banded V values along the path equal the full search's
//  (the path's predecessors are all in-band), and an underestimated non-path
//  predecessor can never flip a backtrack decision (it only makes the losing
//  side look worse). If the backtracked path ever comes close to a band edge,
//  the search is redone without a band, so the answer is always exact.
//  The trace is kept in one flat Int32Array (depth d's segment starts at
//  traceOff[d] and is indexed by j = k + d, one cell per j) instead of one
//  array per depth, which removes D allocations and most GC pressure.
//  Snakes are unrolled 4-at-a-time.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** Band half-margin around the path's diagonal interval. */
const BAND_M = 256;
/** How close the backtracked path may come to a band edge before we redo the search unbanded. */
const EDGE_GUARD = 48;

/** Interned line ids of one text, plus its line count and bare-last-line index. */
function tokenize(text, intern) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  // Lines: parts[0..last-1] each with '\n'; parts[last] only when non-empty (no '\n').
  const count = last + (parts[last] !== '' ? 1 : 0);
  const ids = new Int32Array(count);
  const endsNL = parts[last] === '';
  for (let i = 0; i < last; i++) {
    let id = intern.get(parts[i]);
    if (id === undefined) {
      id = intern.size;
      intern.set(parts[i], id);
    }
    ids[i] = id;
  }
  if (parts[last] !== '') {
    let id = intern.get(parts[last]);
    if (id === undefined) {
      id = intern.size;
      intern.set(parts[last], id);
    }
    // The bare last line is a different line from the same text with '\n':
    // mark it in a separate id namespace (ids are < 2^30 here).
    ids[last] = id | 0x40000000;
  }
  return { parts, ids, count, bare: endsNL ? -1 : count - 1 };
}

/**
 * Myers greedy search over the middle slices a[ao..ao+n), b[bo..bo+m),
 * with makefun-diff's tie-break (deletion wins) and boundary rules.
 * When band is true the diagonals are restricted to [lo, hi]; otherwise the
 * full range is explored. Returns { runs, kMin, kMax }: the edit runs
 * [{ kind, count }] of the middle, in order, and the backtracked path's
 * diagonal range.
 *
 * The frontier is kept in one flat Int32Array: depth d's segment starts at
 * traceOff[d] and holds its diagonals at even j = k + d, cell (j - jLo(d)).
 * A diagonal's predecessors at depth d-1 sit at absolute j (add) and j-2
 * (remove) in the previous segment, so with prevBase = traceOff[d-1] -
 * jLo(d-1) they are prev[prevBase + j] and prev[prevBase + j - 2]. A value
 * of -1 means that diagonal holds no path at that depth.
 */
function editRuns(a, ao, n, b, bo, m, band) {
  const kStar = n - m;
  const lo = band ? Math.min(0, kStar) - BAND_M : -(n + m);
  const hi = band ? Math.max(0, kStar) + BAND_M : n + m;

  // Flat trace: depth d's segment starts at traceOff[d]; it is indexed by
  // j = k + d, one cell per j (odd j unused). Grown inline, no closure.
  let trace = new Int32Array(1 << 22);
  const traceOff = [0];

  // j bounds of depth d: even j in [jLo(d), jHi(d)].
  const jLo = (d) => {
    const w = lo + d;
    const v = w < 0 ? 0 : w;
    return v + (v & 1);
  };
  const jHi = (d) => {
    const v = hi + d;
    const w = v > 2 * d ? 2 * d : v;
    return w - (w & 1);
  };

  // d = 0: the initial snake from (0, 0). Depth 0's segment is 1 cell at offset 0.
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[ao + x] === b[bo + y]) {
    x++;
    y++;
  }
  trace[0] = x;
  if (x === n && y === m) {
    return { runs: n === 0 ? [] : [{ kind: KEEP, count: n }], kMin: 0, kMax: 0 };
  }
  let D = -1;
  let K = 0;
  const maxEdit = n + m;
  const aLim = ao + n;
  const bLim = bo + m;
  let cur = 1; // next free offset (depth 0 used offset 0)
  let prevHasDead = false;
  for (let d = 1; d <= maxEdit; d++) {
    const dm1 = d - 1;
    const jl = jLo(d);
    const jh = jHi(d);
    const segLen = jh - jl + 1;
    const prevOff = traceOff[d - 1];
    const prevLo = jLo(dm1);
    const prevHi = jHi(dm1);
    const prevBase = prevOff - prevLo;
    const need = cur + segLen;
    if (need > trace.length) {
      let size = trace.length;
      while (size < need) size *= 2;
      const nt = new Int32Array(size);
      nt.set(trace);
      trace = nt;
    }
    traceOff.push(cur);
    const curBase = cur - jl;
    let done = false;
    let hasDead = false;
    // One diagonal's snake, from (nx, ny); returns [nx, ny] via the locals.
    // Inlined as a code block below (not a closure) for speed.
    if (!prevHasDead) {
      // Fast path: the previous depth holds no -1, so every structurally
      // available candidate is >= 0 and only the text-end bounds are checked.
      // Edge diagonal j = jl: only the add candidate (diagonal jl at depth d-1).
      {
        const xAdd = jl <= prevHi ? trace[prevBase + jl] : -1;
        if (xAdd >= 0 && xAdd - jl + dm1 < m) {
          let nx = xAdd;
          let ny = nx - jl + d;
          let ai = ao + nx;
          let bi = bo + ny;
          while (ai + 3 < aLim && bi + 3 < bLim && a[ai] === b[bi] && a[ai + 1] === b[bi + 1] && a[ai + 2] === b[bi + 2] && a[ai + 3] === b[bi + 3]) { ai += 4; bi += 4; }
          while (ai < aLim && bi < bLim && a[ai] === b[bi]) { ai++; bi++; }
          nx = ai - ao; ny = bi - bo;
          trace[curBase + jl] = nx;
          if (nx === n && ny === m) { D = d; K = jl - d; done = true; }
        } else {
          trace[curBase + jl] = -1;
          hasDead = true;
        }
      }
      if (!done) {
        // Middle diagonals: both candidates defined, no >= 0 checks.
        let carry = trace[prevBase + jl];
        for (let j = jl + 2; j <= jh - 2; j += 2) {
          const xRemove = carry;
          const xAdd = trace[prevBase + j];
          carry = xAdd;
          const canRemove = xRemove < n;
          const canAdd = xAdd - j + dm1 < m;
          if (!canRemove && !canAdd) {
            trace[curBase + j] = -1;
            hasDead = true;
            continue;
          }
          let nx = canRemove && (!canAdd || xRemove + 1 >= xAdd) ? xRemove + 1 : xAdd;
          let ny = nx - j + d;
          let ai = ao + nx;
          let bi = bo + ny;
          while (ai + 3 < aLim && bi + 3 < bLim && a[ai] === b[bi] && a[ai + 1] === b[bi + 1] && a[ai + 2] === b[bi + 2] && a[ai + 3] === b[bi + 3]) { ai += 4; bi += 4; }
          while (ai < aLim && bi < bLim && a[ai] === b[bi]) { ai++; bi++; }
          nx = ai - ao; ny = bi - bo;
          trace[curBase + j] = nx;
          if (nx === n && ny === m) { D = d; K = j - d; done = true; break; }
        }
      }
      if (!done && jh > jl) {
        // Edge diagonal j = jh: only the remove candidate (diagonal jh-2 at depth d-1).
        const xRemove = trace[prevBase + jh - 2];
        if (xRemove >= 0 && xRemove < n) {
          let nx = xRemove + 1;
          let ny = nx - jh + d;
          let ai = ao + nx;
          let bi = bo + ny;
          while (ai + 3 < aLim && bi + 3 < bLim && a[ai] === b[bi] && a[ai + 1] === b[bi + 1] && a[ai + 2] === b[bi + 2] && a[ai + 3] === b[bi + 3]) { ai += 4; bi += 4; }
          while (ai < aLim && bi < bLim && a[ai] === b[bi]) { ai++; bi++; }
          nx = ai - ao; ny = bi - bo;
          trace[curBase + jh] = nx;
          if (nx === n && ny === m) { D = d; K = jh - d; done = true; }
        } else {
          trace[curBase + jh] = -1;
          hasDead = true;
        }
      }
    } else {
      // Safe loop: the previous depth holds a dead diagonal, so candidates may be -1.
      let carry = -1;
      for (let j = jl; j <= jh; j += 2) {
        const xRemove = carry;
        const xAdd = j <= prevHi ? trace[prevBase + j] : -1;
        carry = xAdd;
        const canRemove = xRemove >= 0 && xRemove < n;
        const canAdd = xAdd >= 0 && xAdd - j + dm1 < m;
        if (!canRemove && !canAdd) {
          trace[curBase + j] = -1;
          hasDead = true;
          continue;
        }
        let nx = canRemove && (!canAdd || xRemove + 1 >= xAdd) ? xRemove + 1 : xAdd;
        let ny = nx - j + d;
        let ai = ao + nx;
        let bi = bo + ny;
        while (ai + 3 < aLim && bi + 3 < bLim && a[ai] === b[bi] && a[ai + 1] === b[bi + 1] && a[ai + 2] === b[bi + 2] && a[ai + 3] === b[bi + 3]) { ai += 4; bi += 4; }
        while (ai < aLim && bi < bLim && a[ai] === b[bi]) { ai++; bi++; }
        nx = ai - ao; ny = bi - bo;
        trace[curBase + j] = nx;
        if (nx === n && ny === m) { D = d; K = j - d; done = true; break; }
      }
    }
    cur = need;
    prevHasDead = hasDead;
    if (done) break;
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // V value at depth d, diagonal kk; -1 when kk is not a diagonal of depth d
  // (outside the band or wrong parity), so the backtrack never reads stale cells.
  const valAt = (d, kk) => {
    if (((kk - d) & 1) !== 0) return -1;
    const klo = lo > -d ? lo : -d;
    const khi = hi < d ? hi : d;
    if (kk < klo || kk > khi) return -1;
    return trace[traceOff[d] + (kk + d - jLo(d))];
  };

  // Backtrack the single path: at each depth the move is recomputed from the
  // stored V exactly as the forward pass chose it. Segments are collected in
  // reverse (snake, then move per depth), then reversed into runs.
  const segs = [];
  let k = K;
  let kMin = K;
  let kMax = K;
  for (let d = D; d >= 1; d--) {
    const xx = valAt(d, k);
    const xRemove = k > -d ? valAt(d - 1, k - 1) : -1;
    const xAdd = k < d ? valAt(d - 1, k + 1) : -1;
    const canRemove = xRemove >= 0 && xRemove < n;
    const canAdd = xAdd >= 0 && xAdd - k - 1 < m;
    let x0;
    let kind;
    if (canRemove && (!canAdd || xRemove + 1 >= xAdd)) {
      x0 = xRemove + 1;
      kind = DELETE;
      k = k - 1;
    } else {
      x0 = xAdd;
      kind = INSERT;
      k = k + 1;
    }
    if (k < kMin) kMin = k;
    if (k > kMax) kMax = k;
    if (xx - x0 > 0) segs.push({ kind: KEEP, count: xx - x0 });
    segs.push({ kind, count: 1 });
  }
  const x0 = trace[0];
  if (x0 > 0) segs.push({ kind: KEEP, count: x0 });

  // Reverse into forward order, merging consecutive runs of one kind.
  const runs = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const last = runs.length === 0 ? undefined : runs[runs.length - 1];
    if (last !== undefined && last.kind === s.kind) last.count += s.count;
    else runs.push({ kind: s.kind, count: s.count });
  }
  return { runs, kMin, kMax };
}

/** make.fun's own patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const intern = new Map();
  const A = tokenize(input.old, intern);
  const B = tokenize(input.new, intern);
  const a = A.ids;
  const b = B.ids;
  const n = A.count;
  const m = B.count;

  // Common prefix, then common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
  const nMid = n - prefix - suffix;
  const mMid = m - prefix - suffix;
  const kStarMid = nMid - mMid;
  let mid = editRuns(a, prefix, nMid, b, prefix, mMid, true);
  // If the banded path came close to a band edge, the band may have been too
  // narrow for this case: redo the search without a band (exact, slower).
  if (mid.kMin <= Math.min(0, kStarMid) - BAND_M + EDGE_GUARD ||
      mid.kMax >= Math.max(0, kStarMid) + BAND_M - EDGE_GUARD) {
    mid = editRuns(a, prefix, nMid, b, prefix, mMid, false);
  }
  const midRuns = mid.runs;

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (const r of midRuns) runs.push(r);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // Change runs: each a stretch of deletions/insertions between kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes.length === 0 ? undefined : changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // Hunks: change runs at most 6 kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length === 0 ? undefined : hunks[hunks.length - 1];
    const prev = h === undefined ? undefined : h[h.length - 1];
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  const aParts = A.parts;
  const bParts = B.parts;
  const aBare = A.bare;
  const bBare = B.bare;
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - 3);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push('@ ', String(oldStart + 1), ' ', String(oldEnd - oldStart), ' ', String(newStart + 1), ' ', String(newEnd - newStart), '\n');
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) {
        if (at === aBare) out.push('=', aParts[at], '\n%\n');
        else out.push('=', aParts[at], '\n');
      }
      for (let i = 0; i < c.dels; i++) {
        const idx = c.o + i;
        if (idx === aBare) out.push('-', aParts[idx], '\n%\n');
        else out.push('-', aParts[idx], '\n');
      }
      for (let i = 0; i < c.ins; i++) {
        const idx = c.p + i;
        if (idx === bBare) out.push('+', bParts[idx], '\n%\n');
        else out.push('+', bParts[idx], '\n');
      }
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) {
      if (at === aBare) out.push('=', aParts[at], '\n%\n');
      else out.push('=', aParts[at], '\n');
    }
  }
  return out.join('');
}
