# runtime/worker/

The worker entry plus the correlated message protocol where every message
carries a `jobId`, so a late message from a cancelled or timed-out job can
never be attributed to a newer job. `cancel()` terminates the worker and the
library transparently re-initializes on the next job. Classic worker — no
SharedArrayBuffer or COOP/COEP.
