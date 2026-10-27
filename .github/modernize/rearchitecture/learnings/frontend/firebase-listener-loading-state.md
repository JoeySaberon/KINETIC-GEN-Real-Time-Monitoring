# Firebase Listener Loading State

Use the existing realtime listener's initial-snapshot state to drive loading UI before rendering connection status.

## What Happened

For piezo-dashboard task t1, the header status could retain a prior online/offline value while Firebase listeners were being re-established. The existing `onValue` listener already had an initial snapshot boundary, so the focused fix reset status on subscription and rendered `Loading` while `deviceDataLoading` was true. The redundant status polling interval was removed.

## Takeaway

When a Firebase Realtime Database listener is authoritative, reset connection-dependent UI at subscription start, let the initial callback end loading, and retain unsubscribe cleanup in the effect. Avoid a second polling loop for the same status surface.

## History

- 2026-09-18 (piezo-dashboard/t1): initial
