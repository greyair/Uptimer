# P2.1 Scheduler Scale Benchmark

Date: 2026-09-25

## Purpose

P2.1 establishes a reproducible scheduler/storage scaling baseline for 10, 25, and 50 active monitors before P2.2 changes Globalping history writes. It is a synthetic regression benchmark, not a Cloudflare D1 billing simulator.

Baseline runtime: `053ff1f7dd525e9845166de96c9effe0e697af72` (P1 production baseline).

## Method

The benchmark runs 18 scenarios:

- monitor counts: 10, 25, 50;
- normal staggered load: approximately one fifth of 300-second monitors due in a tick;
- burst load: every monitor due in the same tick;
- profile configuration: `low-write`, `balanced`, `high-scale`.

External network latency is excluded from the benchmark. The fake D1 harness records executed read/write operations and classifies lock, check-result, monitor-state, and snapshot writes. The same benchmark file, fake D1 fixture, and instrumentation are overlaid onto the P1 baseline and current worktrees so the counters have identical semantics.

CI command:

```sh
pnpm --filter @uptimer/worker bench:scheduler
```

The dedicated **P2 Scale Benchmark** workflow runs 8 measured iterations after 2 warmups and uploads both the raw JSON and console output.

## Results

The final P2.1 CI run completed successfully on commit `ad89a79be178383de4574a5810b4989baae1842d`. Baseline and current D1 operation counts are identical, which is expected: P2.1 adds measurement infrastructure and does not change scheduler persistence behavior.

Representative per-tick operation counts:

| Active monitors | Due monitors | Load | D1 reads | D1 writes | Lock writes | Check-result writes | State writes | Snapshot writes |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 2 | staggered | 28 | 5 | 2 | 1 | 1 | 1 |
| 25 | 5 | staggered | 31 | 5 | 2 | 1 | 1 | 1 |
| 50 | 10 | staggered | 36 | 5 | 2 | 1 | 1 | 1 |
| 10 | 10 | burst | 36 | 5 | 2 | 1 | 1 | 1 |
| 25 | 25 | burst | 51 | 9 | 2 | 3 | 3 | 1 |
| 50 | 50 | burst | 76 | 13 | 2 | 5 | 5 | 1 |

The three profile labels produce the same operation counts in this harness. This is expected for the inline scheduler path.

Local wall-clock measurements remained in the low-single-digit millisecond range in CI. Differences between baseline and current varied in both directions while operation counts stayed identical, so timing deltas are treated as runner noise rather than a performance change.

## Interpretation

For the modeled 300-second cadence, staggered load grows slowly through 50 active monitors because only the due subset is processed per tick. The 50-monitor staggered scenario records 36 D1 reads and 5 D1 writes.

The all-due burst is the useful stress case. At 50 due monitors it records 76 D1 reads and 13 D1 writes. Growth is bounded and approximately proportional to the number of persistence batches; no nonlinear scheduler/storage amplification appears in the 10/25/50 range.

These are operation counts in the fake D1 harness. They are not equivalent to Cloudflare `rows_read` or `rows_written`, because a single D1 statement can scan or mutate multiple rows. Production D1 Diagnostics remains the source of truth for Free Plan consumption.

## High-scale limitation

The current microbenchmark does **not** provide a Worker `SELF` service binding. Therefore the `high-scale` rows validate high-scale configuration against the inline scheduler harness, but they do not exercise the full service-batch, runtime-fragment, or sharded-continuation pipeline.

A full high-scale conclusion requires a separate integration benchmark with a realistic `SELF` binding. P2.1 deliberately records this limitation instead of simulating a service path that would not be representative.

## P2.1 conclusion

P2.1 acceptance is satisfied for the inline scheduler/storage path:

- 10/25/50 scenarios are deterministic and CI-reproducible;
- staggered and all-due burst scheduling complete without correctness regressions;
- D1 operation categories are measured with identical baseline/current instrumentation;
- raw benchmark JSON is retained as a CI artifact;
- no evidence in this range justifies automatic profile switching.

The next inline scale point worth testing is 100 monitors, but it is not required before P2.2. P2.2 should first reduce Globalping history writes, then this same benchmark should be rerun for regression comparison. Full `high-scale` service/sharded validation remains a separate integration-scale task for P3 or earlier if production diagnostics require it.
