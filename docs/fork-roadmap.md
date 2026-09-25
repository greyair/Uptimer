# Fork Roadmap

This roadmap tracks fork-specific production maintenance and optimization work for `greyair/Uptimer`.
It is intentionally separate from `Develop/Plan.md`, which remains the upstream/product delivery plan.

## Operating principles

- `master` is the only production baseline.
- New work starts from current `master`.
- Prefer measured Cloudflare Free Plan behavior over monitor-count heuristics.
- Do not auto-switch runtime profiles based only on monitor count.
- Preserve immediate status propagation for real monitor changes while avoiding idle D1 work.
- Use the manual **D1 Diagnostics** workflow for production before/after validation.
- Keep the sharded/fragment implementation available for larger deployments until scale tests prove it unnecessary.

## P0 — Production maintenance baseline

**Status: complete**

Delivered:

- D1 read-amplification reduction:
  - bounded per-monitor heartbeat reads
  - runtime uptime totals reused before daily aggregation fallback
  - runtime freshness aligned with monitor cadence
- Low Write production flags for the small Free Plan deployment.
- Scheduler idle-tick optimization: no scheduler lease when no monitor is due.
- Permanent manual D1 diagnostics workflow.
- Direct-monitor edit compatibility fix and structured admin validation errors.
- Fork/upstream differences and branch policy documented.
- Historical `feature/extended-monitoring` branch marked deprecated; temporary merged hotfix branches retired.

Acceptance evidence:

- Heavy daily uptime aggregation disappeared from the normal hot path and is only an infrequent fallback.
- Partitioned heartbeat history scan no longer appears as a recurring D1 hotspot.
- Production CI/deploy verification passed after each release.

## P1 — Runtime profiles and Low Write snapshot cadence

**Status: complete**

Delivered:

- `UPTIMER_PROFILE` abstraction:
  - `low-write`
  - `balanced`
  - `high-scale`
- Individual `UPTIMER_*` variables remain explicit overrides.
- Production selects `low-write`.
- Low Write scheduled public snapshot freshness defaults to 300 seconds.
- Idle one-minute Cron ticks do not rewrite public snapshots.
- Completed monitor checks and forced admin invalidations still refresh public state immediately.

Production validation (2026-09-25):

- Production monitor count during validation: 5, with intervals around 292–300 seconds.
- 1h Top-20 D1 reads: about 2.55k rows.
- 1h Top-20 D1 writes: about 436 rows.
- Snapshot-related writes fell from 145/h on the previous 4-monitor baseline to 93/h with 5 monitors.
- Per-monitor normalized snapshot writes fell from about 36.25/h to 18.6/h (~49% reduction).
- Daily uptime fallback SQL and the previous recurring heartbeat window scan were absent from the clean P1 1h window.

## P2 — Scale validation and write optimization

**Status: in progress**

### P2.1 — Synthetic 10 / 25 / 50 monitor scale benchmark

**Status: complete**

Goal: establish measured profile/capacity guidance instead of guessing thresholds.

Final report: [P2.1 Scheduler Scale Benchmark](benchmarks/p2-scale.md).

Measured inline scheduler results (2026-09-25):

- 50 active / 10 due staggered tick: 36 synthetic D1 read operations and 5 writes.
- 50 active / 50 due burst tick: 76 synthetic D1 read operations and 13 writes.
- Baseline/current operation counts match after applying identical harness instrumentation.
- No nonlinear scheduler/storage amplification was observed through 50 monitors.
- Full `high-scale` SELF/service/sharded behavior is explicitly outside this microbenchmark and requires a separate integration benchmark.

Delivered tasks:

- Add a deterministic synthetic benchmark harness that can model 10, 25, and 50 active monitors.
- Cover both:
  - staggered due times, representative of normal production;
  - burst/all-due scheduling, representative of a worst-case Cron tick.
- Exercise `low-write`, `balanced`, and `high-scale` profile behavior where practical.
- Record/derive:
  - scheduler work per tick;
  - check/result and state write counts;
  - snapshot/lock write behavior;
  - D1 read/write operation counts available from the test harness;
  - runtime/CPU wall-clock as a local regression signal, not as a Cloudflare billing measurement.
- Keep external HTTP/Globalping calls mocked; this benchmark is for Uptimer scheduler/storage scaling, not third-party network latency.
- Produce a checked-in benchmark report with methodology, results, and profile guidance.
- Do not establish automatic profile switching from these results.

Acceptance:

- 10/25/50 scenarios are reproducible in CI or by a documented command.
- No correctness regression under staggered or burst scheduling.
- Results identify the next scale point worth testing; any profile recommendation is tied to measured data.

### P2.2 — Globalping history downsampling

**Status: complete**

Goal: reduce history-table writes without reducing freshness of the latest regional status.

Target behavior:

- Continue updating latest Globalping results on every check.
- Persist normal steady-state history at approximately 15-minute intervals.
- Persist history immediately on meaningful transitions:
  - region/global status change;
  - error/failure appearance;
  - recovery.
- Preserve compatibility with existing 24h history data and APIs.
- Ensure charts remain correct with irregular/downsampled timestamps.
- Keep retention behavior unchanged unless measurements justify a separate change.

Delivered and validated:

- Latest Globalping results remain updated on every monitor check.
- Stable history is persisted on a 15-minute cadence.
- Region status/error transitions and recovery bypass the cadence and persist immediately.
- The existing `globalping_history` schema/API and retention behavior remain compatible.
- Policy tests cover first sample, stable cadence, failure, error appearance, and recovery.
- Scheduler persistence tests verify latest-result writes and history-write suppression/transition behavior.
- The P2 benchmark was rerun against the P1 production baseline:
  - 12 five-minute checks over one stable hour;
  - latest-result writes: 12 → 12;
  - history writes: 12 → 4 (-66.7%);
  - synthetic D1 writes: 48 → 40 (-16.7%);
  - no additional synthetic D1 reads.
- Detailed measurements are recorded in [P2 Scheduler Scale and Write Benchmark](benchmarks/p2-scale.md).

Production acceptance (2026-09-25):

- Production validation ran on 5 active monitors with intervals around 292–300 seconds.
- The active Globalping monitor (`neodb`, 292-second interval) completed 12 checks in the selected 1h window.
- Latest Globalping state continued to update at monitor cadence; the latest check was at 19:22 UTC while the latest retained history sample was at 19:12 UTC.
- Direct D1 history inspection found 4 `globalping_history` rows in the same 1h window.
- The 4 retained samples were spaced exactly 900 seconds apart: min/avg/max gap = 900/900/900 seconds, with no gap below the 15-minute steady-state cadence.
- The production result therefore matches the synthetic benchmark exactly: 12 checks → 4 steady-state history rows (-66.7% versus writing history on every check).
- Public snapshots remained fresh (~44 seconds at diagnostics time), the legacy fragment table remained idle, and the previous heavy uptime/window-scan queries did not reappear.
- The direct history-interval diagnostic is intentionally manual-only; its read cost is not part of the production hot path.

Acceptance: satisfied in policy tests, scheduler persistence tests, synthetic benchmark, and direct production D1 validation.

Next observation step:

- Keep the current production deployment unchanged for several days and watch D1 Diagnostics for regressions or unexpected write/read hotspots.
- Then increase the production monitor count gradually and rerun the same 1h/24h diagnostics at each useful scale point.
- Use those measurements, rather than monitor count alone, to decide whether P2.3 or the P3 100+ monitor/high-scale work is warranted.

### P2.3 — MCP operational enhancements

**Status: optional; scope after P2.1/P2.2**

Candidate work only when it serves a demonstrated operational need:

- expose profile/runtime diagnostics;
- improve bulk monitor management;
- expose useful Globalping history/diagnostic queries.

Do not add endpoints solely to complete the phase.

## P3 — Conditional deep optimization and larger-scale work

**Status: planned / evidence-triggered**

- Rework the daily uptime fallback SQL only if D1 Diagnostics shows it becoming a recurring hotspot again.
- Validate 100+ monitors and `high-scale` behavior after P2 establishes a useful test methodology.
- Revisit sharded/fragment pipeline defaults from measured scale data.
- Consider Globalping request-body support and other adapter features separately from cost optimization.
- Continue upstream-sync review for fork-only changes.

## Execution order

1. P2.1 benchmark harness and baseline report.
2. P2.2 Globalping history downsampling.
3. Re-run P2.1 and update the report with before/after write behavior.
4. Decide whether P2.3 has enough operational value to implement.
5. Enter P3 only when diagnostics or scale tests provide evidence for it.

## Documentation ownership

- `Develop/Plan.md`: upstream/product delivery phases.
- `docs/fork-differences.md`: current functional and operational differences from upstream.
- `docs/fork-roadmap.md`: fork-specific maintenance/optimization plan and phase status.
