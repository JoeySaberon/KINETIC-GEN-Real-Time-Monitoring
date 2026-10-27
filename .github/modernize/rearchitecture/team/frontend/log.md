## [t1] Reset Firebase header status during listener loading

- The dashboard already had Firebase Realtime Database `onValue` subscriptions and cleanup; a separate `lastDeviceUpdate` interval was responsible for polling status.
- Status is now explicitly `Loading` during listener setup and the rendered value is derived from `deviceDataLoading`, preventing stale online/offline display before the first `KineticGen` snapshot.
- Validation: `npm run build` passed; `src/App.jsx` has no editor diagnostics.
- Learnings consumed: [(none)]
