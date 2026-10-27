# t1 — Firebase Status Loading Reset

## Summary

Updated the dashboard header status in `src/App.jsx` so Firebase listener loading cannot display a stale prior status. The existing `onValue` subscriptions remain the source of truth, and the redundant status polling interval was removed.

## Upstream Artifacts Consumed

- none — no dependency artifacts provided

## Evidence Mapping

- none — no dependency artifacts provided

## Changed Files

- `src/App.jsx` — initializes status as `Loading`, resets listener-related state on subscription, renders loading directly from `deviceDataLoading`, keeps the pill visible during loading, and removes the status polling effect.

## Behavior

- On initial load or auth-driven listener setup, the header shows an amber pulsing `Loading` status.
- The first `KineticGen` realtime snapshot ends loading and the existing connection/device logic determines `Online` or `Offline`.
- Existing Firebase `onValue` cleanup remains intact for every subscription.
- No public UI/API contract was changed beyond eliminating stale status display during loading.

## Test Results

- Command: `npm run build`
- Passed: 1 build
- Failed: 0
- Skipped: 0
- Result: Vite production build completed successfully; only the pre-existing large-chunk warning was reported.
- Additional checks: `get_errors` reported no errors for `src/App.jsx`; no `updateStatus` polling remains.
