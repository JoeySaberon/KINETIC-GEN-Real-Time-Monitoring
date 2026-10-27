## [t3] Focused Vite smoke check and boundary review

- Confirmed the status-pill behavior is controlled by Firebase listener loading state in `src/App.jsx`; unrelated auth timers remain separate.
- `npm run build` passed; Vite emitted only the existing large-chunk warning.
- Learnings consumed: [frontend/firebase-listener-loading-state]
