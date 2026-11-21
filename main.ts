// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Strategy (written from scratch for this entry):
//  - The generated levels are a hallway with 1-4 small rooms off it (3-4 boxes each).
//    A box pushed out of its room can never come back, so each room is independent and
//    the level's push optimum is the sum of the rooms' optima. The solver therefore
//    splits the level into rooms and solves each room push-optimally, then stitches
//    the rooms' move strings together (the player walks between rooms on its own).
//  - Each room is solved by A* over pushes: a state is the boxes' squares plus the
//    player's reachable region (named by its lowest square). A push costs 1; the
//    heuristic is the sum over boxes of the distance to the nearest goal, which is
//    admissible (one push moves one box one square) and consistent.
//  - Deadlock pruning: a box on a dead square (no push sequence, ignoring the other
//    boxes, can ever bring it to a goal) is pruned, and so is a frozen 2x2 block of
//    walls and boxes with a box off its goal. Neither prunes a solvable state.
//  - All budgets are counted in expanded states, never in wall-clock time, and every
//    tie is broken by fixed square/direction order, so two runs write the same bytes.
//  - Fallbacks, in order: whole-level push A*, then a move-based A* (fewest moves,
//    which is not always fewest pushes, but still solves), then an empty answer.
//
// Node 22 runs this file directly (erasable TypeScript only): node /bot/main.ts reads
// /input/<id>/level.txt and writes /output/<id>/solution.txt for each instance.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in expanded states (deterministic, never the clock).
const ROOM_EXPANSIONS = 500_000;
const LEVEL_EXPANSIONS = 500_000;
const MOVE_EXPANSIONS = 300_000;
const TOTAL_EXPANSIONS = 3_000_000;

const budget = { used: 0 };

interface Dir {
  dx: number;
  dy: number;
  step: string;
  push: string;
}

const DIRS: Dir[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] as string;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** Squares from which a box alone can be pushed onto some goal (pulled back from the goals). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi] as number;
    for (const d of DIRS) {
      const dd = d.dy * w + d.dx;
      const y = x - dd;
      if (!wall[y] && !wall[y - dd] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Distance of every square to its nearest goal over open floor (-1 when unreachable). */
function goalDistances(level: Level): Int32Array {
  const { w, wall, goals } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue: number[] = [...goals];
  for (const g of goals) dist[g] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi] as number;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p] as number + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way, marked in
 * `seen` with `stamp`; returns the lowest square reached (the region's name).
 */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n] as number;
    if (p < low) low = p;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case LURD. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi] as number;
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p] as number) s = (how[p] as string) + s;
  return s;
}

function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

interface PushSolution {
  pushes: number;
  moves: string;
}

/**
 * Push-optimal A* over one (sub-)level: {pushes, moves}, or null when the budget runs
 * out or the level has no solution. `maxExpansions` bounds this call's own pops;
 * the shared `budget` bounds the whole run. `stringKey` uses a string state key
 * (for whole levels, where a numeric key would overflow); rooms use numeric keys.
 */
function solvePushAStar(level: Level, maxExpansions: number, stringKey = false): PushSolution | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = goalDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const heuristic = (boxes: number[]): number => {
    let h = 0;
    for (const b of boxes) {
      const d = dist[b] as number;
      if (d < 0) return -1;
      h += d;
    }
    return h;
  };
  if (level.boxes.some((b) => !live[b])) return null;
  const h0 = heuristic(level.boxes);
  if (h0 < 0) return null;

  // State key: the region's lowest square, then the boxes. Numeric keys are exact
  // while size ** (boxes + 1) < 2 ** 53; rooms hold at most 4 boxes.
  const keyOf = (boxes: number[], low: number): number | string => {
    if (stringKey) return `${low}|${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const boxesList: number[][] = [level.boxes];
  const playerList: number[] = [level.player];
  const lowList: number[] = [];
  const gList: number[] = [0];
  const parent: number[] = [-1];
  const pushDir: number[] = [-1]; // index into DIRS of the push that made this state
  const pushBox: number[] = [-1]; // the box square before the push
  const best = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const low0 = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  lowList.push(low0);
  best.set(keyOf(level.boxes, low0), 0);

  // Binary heap of [f, h, counter, state]; ties go to lower h, then earlier entry.
  const heap: [number, number, number, number][] = [[h0, h0, 0, 0]];
  let counter = 1;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i] as [number, number, number, number], heap[p] as [number, number, number, number])) break;
      const tmp = heap[i] as [number, number, number, number];
      heap[i] = heap[p] as [number, number, number, number];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0] as [number, number, number, number];
    const last = heap.pop() as [number, number, number, number];
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1] as [number, number, number, number], heap[c] as [number, number, number, number])) c++;
        if (!less(heap[c] as [number, number, number, number], heap[i] as [number, number, number, number])) break;
        const tmp = heap[i] as [number, number, number, number];
        heap[i] = heap[c] as [number, number, number, number];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  let found = solved(level.boxes) ? 0 : -1;
  let expanded = 0;
  while (heap.length > 0 && found < 0) {
    const [, , , s] = heapPop();
    const boxes = boxesList[s] as number[];
    const g = gList[s] as number;
    if (best.get(keyOf(boxes, lowList[s] as number)) !== g) continue;
    if (expanded >= maxExpansions || budget.used >= TOTAL_EXPANSIONS) return null;
    expanded++;
    budget.used++;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, playerList[s] as number, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi] as number;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di] as Dir;
        const dd = d.dy * w + d.dx;
        const t = b + dd;
        if (seen[b - dd] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string | null = null;
        let next: number[] | null = null;
        let h = -1;
        let nl = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h = heuristic(next);
          if (h >= 0) {
            nl = reach(level, occupied, b, mark, ++stamp, stack);
            key = keyOf(next, nl);
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h < 0 || key === null) continue;
        const seenG = best.get(key);
        if (seenG !== undefined && seenG <= g + 1) continue;
        best.set(key, g + 1);
        const idx = boxesList.length;
        boxesList.push(next as number[]);
        playerList.push(b);
        lowList.push(nl);
        gList.push(g + 1);
        parent.push(s);
        pushDir.push(di);
        pushBox.push(b);
        if (solved(next as number[])) {
          found = idx;
          break;
        }
        heapPush([g + 1 + h, h, counter++, idx]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s] as number) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = boxesList[s] as number[];
    const from = pushBox[s] as number;
    const di = pushDir[s] as number;
    const d = DIRS[di] as Dir;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - (d.dy * w + d.dx));
    for (const b of boxes) occupied[b] = 0;
    moves += d.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box
 * there reaches no goal) out of the floor; each part left that holds a box is a room.
 * Null when the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const d of DIRS) {
        const q = (squares[i] as number) + d.dy * w + d.dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) (rooms[part[b] as number] as Room).boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    (rooms[part[g] as number] as Room).goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the other
 * rooms' boxes standing as walls (on their goals once their room is done), the player
 * walking on from where the last room left it.
 */
function solveByRooms(level: Level): PushSolution | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushAStar(level, LEVEL_EXPANSIONS, true);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushAStar(sub, ROOM_EXPANSIONS);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/**
 * Move-based A* fallback (fewest moves, not necessarily fewest pushes): a state is
 * the player and the boxes, the heuristic the summed distance of each box to its
 * nearest goal. Dead squares prune boxes that can never reach a goal.
 */
function solveMoveAStar(level: Level, maxExpansions: number): string | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = goalDistances(level);
  const heuristic = (boxes: number[]): number => {
    let h = 0;
    for (const b of boxes) {
      const d = dist[b] as number;
      if (d < 0) return -1;
      h += d;
    }
    return h;
  };
  if (level.boxes.some((b) => !live[b])) return null;
  const keyOf = (p: number, boxes: number[]): string => `${p}|${boxes.join(',')}`;
  const players: number[] = [level.player];
  const boxesList: number[][] = [level.boxes];
  const gList: number[] = [0];
  const parent: number[] = [-1];
  const step: string[] = [''];
  const best = new Map<string, number>([[keyOf(level.player, level.boxes), 0]]);
  const h0 = heuristic(level.boxes);
  if (h0 < 0) return null;
  const heap: [number, number, number, number][] = [[h0, h0, 0, 0]];
  let counter = 1;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i] as [number, number, number, number], heap[p] as [number, number, number, number])) break;
      const tmp = heap[i] as [number, number, number, number];
      heap[i] = heap[p] as [number, number, number, number];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0] as [number, number, number, number];
    const last = heap.pop() as [number, number, number, number];
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1] as [number, number, number, number], heap[c] as [number, number, number, number])) c++;
        if (!less(heap[c] as [number, number, number, number], heap[i] as [number, number, number, number])) break;
        const tmp = heap[i] as [number, number, number, number];
        heap[i] = heap[c] as [number, number, number, number];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };
  let expanded = 0;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const g = gList[s] as number;
    const p = players[s] as number;
    const bs = boxesList[s] as number[];
    if (best.get(keyOf(p, bs)) !== g) continue;
    if (bs.every((b) => goal[b])) {
      let moves = '';
      for (let t = s; t > 0; t = parent[t] as number) moves = (step[t] as string) + moves;
      return moves;
    }
    if (expanded >= maxExpansions || budget.used >= TOTAL_EXPANSIONS) return null;
    expanded++;
    budget.used++;
    for (const d of DIRS) {
      const dd = d.dy * w + d.dx;
      const q = p + dd;
      if (wall[q]) continue;
      let nb = bs;
      let move = d.step;
      const at = bs.indexOf(q);
      if (at >= 0) {
        if (wall[q + dd] || bs.includes(q + dd) || !live[q + dd]) continue;
        nb = bs.slice();
        nb[at] = q + dd;
        nb.sort((a, b) => a - b);
        move = d.push;
      }
      const h = heuristic(nb);
      if (h < 0) continue;
      const k = keyOf(q, nb);
      const seenG = best.get(k);
      if (seenG !== undefined && seenG <= g + 1) continue;
      best.set(k, g + 1);
      const t = players.length;
      players.push(q);
      boxesList.push(nb);
      gList.push(g + 1);
      parent.push(s);
      step.push(move);
      heapPush([g + 1 + h, h, counter++, t]);
    }
  }
  return null;
}

function solveLevel(text: string): string {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePushAStar(level, LEVEL_EXPANSIONS, true);
  if (whole !== null) return whole.moves;
  const byMoves = solveMoveAStar(level, MOVE_EXPANSIONS);
  if (byMoves !== null) return byMoves;
  return '';
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
