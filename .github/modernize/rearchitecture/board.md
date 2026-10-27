## User Input

> Implement the user's focused task in c:\PiezoTile_Monitoring_System\piezo-dashboard: fix the header status pill so refresh does not preserve/display stale previous state while waiting for Firebase, use the existing Firebase SDK's realtime listener rather than polling, initialize UI from listener loading state, clean up subscriptions, preserve existing UI/APIs, make the smallest focused change, and run the narrowest relevant validation/build/test. Do not perform assessment or planning. Return files changed, behavior, and validation results.

**Project started**: 2026-09-18T14:01:47Z

## Tasks

### Phase: Implementation

- ✅ t1 [frontend] Reset header status during Firebase listener loading and clean up realtime subscription (14:01:47Z→14:11:08Z, 9m 21s)

### Phase: Validation

- 🔄 t2 [tester] Run the narrowest relevant frontend validation for the listener/loading behavior [deps: t1]

### Phase: Smoke Check

- 🔄 t3 [architect] Run the focused Vite build smoke check and review the implementation boundary [deps: t1]
