// diff-speed-01: a fast drop-in for makefun-diff 1.0.0.
// Returns, for { old, new }, exactly makefun-diff 1.0.0's patch as one JSON string.
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
// Speed: lines are interned to small integer ids once (one shared Map), so the
// whole Myers search and every snake walk compare integers, never strings, and
// the search keeps its frontier in flat Int32Array V-vectors (one per edit depth)
// instead of allocating a path object per step as the reference does. The patch
// is built by pushing bare fragments into one array and joining once.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

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
 * Returns the edit runs [{ kind, count }] of the middle, in order.
 *
 * The frontier is kept as one Int32Array V per edit depth d: V[k] at index
 * k+d is the old-lines count x reached on diagonal k (-1: no path there).
 * Diagonals are walked with a running index j = k+d (step 2), and the add
 * candidate of one step is carried into the next step as its remove
 * candidate, so each V cell is read once.
 */
function editRuns(a, ao, n, b, bo, m) {
  // trace[d] is the V vector of depth d.
  const trace = [];
  // d = 0: the initial snake from (0, 0).
  let v0 = new Int32Array(1);
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[ao + x] === b[bo + y]) {
    x++;
    y++;
  }
  v0[0] = x;
  trace.push(v0);
  if (x === n && y === m) {
    return n === 0 ? [] : [{ kind: KEEP, count: n }];
  }
  let D = -1;
  let K = 0;
  const maxEdit = n + m;
  let prevHasDead = false; // whether the previous V holds a -1 (a diagonal with no path)
  for (let d = 1; d <= maxEdit; d++) {
    const prev = trace[d - 1];
    const v = new Int32Array(2 * d + 1);
    const dm1 = d - 1;
    const end = 2 * d;
    let done = false;
    let hasDead = false;
    // A diagonal is dead only when both its candidates are unavailable, and
    // that can only happen at the frontier's edges (the two end conditions
    // contradict in the interior). So when the previous V holds no -1, the
    // middle diagonals always have both candidates: the loop below skips
    // the >= 0 checks there and handles the two edge diagonals separately.
    if (!prevHasDead) {
      // Edge diagonal k = -d: only the add candidate (diagonal k+1 at d-1).
      {
        const xAdd = prev[0];
        if (xAdd >= 0 && xAdd + dm1 < m) {
          let nx = xAdd;
          let ny = nx + d;
          let ai = ao + nx;
          let bi = bo + ny;
          while (nx < n && ny < m && a[ai] === b[bi]) {
            nx++;
            ny++;
            ai++;
            bi++;
          }
          v[0] = nx;
          if (nx === n && ny === m) {
            D = d;
            K = -d;
            done = true;
          }
        } else {
          v[0] = -1;
          hasDead = true;
        }
      }
      if (!done) {
        // Middle diagonals: both candidates defined, no >= 0 checks.
        let carry = prev[0];
        for (let j = 2; j <= end - 2; j += 2) {
          const xRemove = carry;
          const xAdd = prev[j];
          carry = xAdd;
          const canRemove = xRemove < n;
          const canAdd = xAdd - j + dm1 < m;
          if (!canRemove && !canAdd) {
            v[j] = -1;
            hasDead = true;
            continue;
          }
          let nx = canRemove && (!canAdd || xRemove + 1 >= xAdd) ? xRemove + 1 : xAdd;
          let ny = nx - j + d;
          let ai = ao + nx;
          let bi = bo + ny;
          while (nx < n && ny < m && a[ai] === b[bi]) {
            nx++;
            ny++;
            ai++;
            bi++;
          }
          v[j] = nx;
          if (nx === n && ny === m) {
            D = d;
            K = j - d;
            done = true;
            break;
          }
        }
      }
      if (!done) {
        // Edge diagonal k = d: only the remove candidate (diagonal k-1 at d-1).
        const xRemove = prev[end - 2];
        if (xRemove >= 0 && xRemove < n) {
          let nx = xRemove + 1;
          let ny = nx - d;
          let ai = ao + nx;
          let bi = bo + ny;
          while (nx < n && ny < m && a[ai] === b[bi]) {
            nx++;
            ny++;
            ai++;
            bi++;
          }
          v[end] = nx;
          if (nx === n && ny === m) {
            D = d;
            K = d;
            done = true;
          }
        } else {
          v[end] = -1;
          hasDead = true;
        }
      }
    } else {
      // Safe loop: a previous V with a dead diagonal, so candidates may be -1.
      let carry = -1;
      for (let j = 0; j <= end; j += 2) {
        const k = j - d;
        const xRemove = carry;
        const xAdd = j < end ? prev[j] : -1;
        carry = xAdd;
        const canRemove = xRemove >= 0 && xRemove < n;
        const canAdd = xAdd >= 0 && xAdd - j + dm1 < m;
        if (!canRemove && !canAdd) {
          v[j] = -1;
          hasDead = true;
          continue;
        }
        let nx = canRemove && (!canAdd || xRemove + 1 >= xAdd) ? xRemove + 1 : xAdd;
        let ny = nx - k;
        let ai = ao + nx;
        let bi = bo + ny;
        while (nx < n && ny < m && a[ai] === b[bi]) {
          nx++;
          ny++;
          ai++;
          bi++;
        }
        v[j] = nx;
        if (nx === n && ny === m) {
          D = d;
          K = k;
          done = true;
          break;
        }
      }
    }
    trace.push(v);
    prevHasDead = hasDead;
    if (done) break;
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Backtrack the single path: at each depth the move is recomputed from the
  // stored V exactly as the forward pass chose it. Segments are collected in
  // reverse (snake, then move per depth), then reversed into runs.
  const segs = [];
  let k = K;
  for (let d = D; d >= 1; d--) {
    const v = trace[d];
    const prev = trace[d - 1];
    const xx = v[k + d];
    const xRemove = k > -d ? prev[k - 1 + (d - 1)] : -1;
    const xAdd = k < d ? prev[k + 1 + (d - 1)] : -1;
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
    if (xx - x0 > 0) segs.push({ kind: KEEP, count: xx - x0 });
    segs.push({ kind, count: 1 });
  }
  const x0 = trace[0][0];
  if (x0 > 0) segs.push({ kind: KEEP, count: x0 });

  // Reverse into forward order, merging consecutive runs of one kind.
  const runs = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const last = runs.length === 0 ? undefined : runs[runs.length - 1];
    if (last !== undefined && last.kind === s.kind) last.count += s.count;
    else runs.push({ kind: s.kind, count: s.count });
  }
  return runs;
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
  const midRuns = editRuns(a, prefix, n - prefix - suffix, b, prefix, m - prefix - suffix);

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
