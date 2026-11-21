# Sokoban solver — make.fun bounty sokoban-solver-01-run-20261121

Push-optimal Sokoban solver for the make.fun bounty
"Build the best Sokoban solver, 21 November 2026"
(https://make.fun/bounty/sokoban-solver-01-run-20261121).

## How it works

`main.ts` (Node 22, no dependencies) reads `/input/<id>/level.txt` for each
instance and writes `/output/<id>/solution.txt` (the player's moves in LURD,
an upper-case letter marking a push).

The generated levels are a one-square-wide hallway with one to four small
rooms off it (3–4 boxes each). A box pushed out of its room through its door
can never be pushed back, so each room is an independent problem and the
level's push optimum P\* is the sum of its rooms' optima. The solver therefore:

1. **Splits the level into rooms** — it cuts the dead squares of the player's
   (hallway) row out of the floor; each remaining part holding a box is a room.
2. **Solves each room push-optimally with A\*** over pushes: a state is the
   boxes' squares plus the player's reachable region (named by its lowest
   square). A push costs 1; the heuristic is the sum over boxes of the
   distance to the nearest goal — admissible (one push moves one box one
   square) and consistent, so the first solution found is push-optimal.
3. **Prunes deadlocks** — a box on a dead square (no push sequence, ignoring
   the other boxes, can ever bring it to a goal) and frozen 2×2 blocks of
   walls and boxes with a box off its goal. Neither prunes a solvable state.
4. **Stitches the rooms together** — the player walks between rooms on its
   own; other rooms' boxes stand as walls while one room is solved.

All budgets are counted in expanded states, never in wall-clock time, and
every tie is broken by fixed square/direction order, so two runs of the
program write the same bytes.

**Fallbacks** (in order): whole-level push A\*, then a move-based A\* (fewest
moves — not necessarily fewest pushes, but still a valid solution), then an
empty answer, which is valid but scores 0.

## Results (official kit scorer)

| Set | Score | Pushes vs P\* |
| --- | --- | --- |
| Practice set (kit) | **1,000,000** | 13/13, 16/16, 29/29, 47/47, 60/60 |
| Fresh set, seed 1 | **1,000,000** | 12/12, 14/14, 29/29, 55/55, 60/60 |
| Fresh set, seed 2 | **1,000,000** | 12/12, 17/17, 32/32, 45/45, 61/61 |
| Fresh set, seed 3 | **1,000,000** | 13/13, 14/14, 32/32, 44/44, 63/63 |

The fresh sets were drawn with the kit's own published generator from new
seeds. The whole practice set solves in under 1 second (limit: 60 seconds for
the set). The house baseline (plain-astar 1.0.0) scores 200,000 on the
practice set.

## Local run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see LICENSE.
