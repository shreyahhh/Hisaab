# @truepath/attribution

Pure, deterministic, I/O-free attribution engine implementing the 6 models from SPEC §9
(first click, last click, last non-direct, linear, time-decay, position-based). Property-tested
with fast-check: credits always sum to 1, never negative, deterministic output.

Empty scaffold as of M0-1. See `docs/architecture/lld/attribution-engine.md`; the models land
in M3-1.
