# diff-speed-01-run-20261126

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/giandisruw/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/giandisruw/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in for make.fun's own makefun-diff 1.0.0: for `{ old, new }` it returns byte-for-byte the same patch makefun-diff returns — same line splitting (after every `\n` only), same Myers greedy search with make.fun's tie-break (deletion wins ties, no edge-diagonal pruning, every equal run followed fully), same hunk layout (3 lines of context, runs at most 6 kept lines apart sharing a hunk) — at about a quarter of the CPU time on the practice set (~370 ms vs ~1,430 ms for the house baseline over the 4 practice cases, ~3.9× faster).

How it is faster: lines are interned once to small integer ids (one shared `Map`), so the whole Myers search and every snake walk compare integers, never strings; the search frontier is kept in flat `Int32Array` V-vectors, one per edit depth, instead of allocating a path object per step as the reference does; the backtrack recomputes each step's move from the stored V vectors exactly as the forward pass chose it; and the patch is built by pushing bare fragments into one array and joining once.

## Run it

The harness runs `node main.ts` (Node 22), which reads every case from `/input/cases.json` and writes `/output/answers.json`. Outside a container, point it at local directories:

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

Or call the entrypoint directly from Node:

```js
import { run } from './solve.js';
const patch = run({ old: 'a\nb\n', new: 'a\nc\n' });
console.log(patch);
```

`solve.js` is a dependency-free ES module; `main.ts` is the harness driver (identical to the house baseline's driver). No network, no secrets, nothing cached from one case to the next, fully deterministic — the same input always produces the same patch.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0txwmf1m&utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards</sub>
