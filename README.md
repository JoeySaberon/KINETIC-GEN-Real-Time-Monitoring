# KINETIC-GEN: Real-Time Monitoring

Real-time piezoelectric tile monitoring system with separate mobile and web
applications.

## Project structure

- **Mobile app:** [`android/`](./android) - Android application generated with
  Capacitor. The mobile app uses the web build in `dist/` when synced to the
  Android project.
- **Web dashboard:** [`src/`](./src) - React and Firebase dashboard for
  real-time monitoring.
- **Web configuration:** `capacitor.config.json`, `vite.config.js`, and
  `firebase*.json`.

The Android project and web dashboard are kept in the same repository so they
can share the monitoring interface and Firebase configuration without mixing
their source directories.

This dashboard can read **live data** from Firebase Realtime Database. If Firebase is not configured, it falls back to mock data so the UI still works.

## 1) Install

```powershell
cd c:\PiezoTile_Monitoring_System\piezo-dashboard
npm install
```

## 2) Create Firebase Project

1. Go to https://console.firebase.google.com
2. Create a project (any name).
3. Add a **Web App**.
4. In Firebase left menu: **Build → Realtime Database → Create Database**.
5. In Firebase left menu: **Build → Authentication → Sign-in method**.
6. Enable **Email/Password** sign-in.
7. Create a user with the email `joeysaberon8@gmail.com`.

## 3) Get Firebase Config

After creating the Web App, Firebase shows a config object like:

```
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  databaseURL: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

## 4) Add Your Keys (Vite .env)

1. Copy `.env.example` to `.env`.
2. Paste your values into `.env`:

```
VITE_FIREBASE_API_KEY=your_key
VITE_FIREBASE_AUTH_DOMAIN=your_app.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://your_app-default-rtdb.asia-southeast1.firebasedatabase.app
VITE_FIREBASE_PROJECT_ID=your_app
VITE_FIREBASE_STORAGE_BUCKET=your_app.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123:web:abc
```

## 4b) Set Realtime Database Rules

Publish the rules from [firebase.rules.json](firebase.rules.json) in Firebase Console → Realtime Database → Rules. Any signed-in Firebase account can read and write the dashboard data. Unauthenticated requests are denied. The `users` records remain protected: users can read their own record, and only the owner can write role records.

The dashboard's **Create account** action is available to any signed-in, verified user from the profile menu on both the website and Android app. It creates the Firebase Authentication account and sends a verification email. The new account holder must verify their email before signing in.

## 5) Run the Dashboard

```powershell
npm run dev
```

Open the URL shown by Vite (usually http://localhost:5173).

## 6) Firebase Data Format (What the app reads)

The dashboard listens to these paths:

- `KineticGen`
- `telemetry/latest`
- `telemetry/history`
- `telemetry/historyClearedAt`
- `readings/{timestamp}`
- `steps/{timestamp}`

The `KineticGen` node should contain the live ESP32 values used by the tile cards:

```json
{
  "tileName": "KineticGen",
  "zone": "Zone A",
  "piezoVoltage": 3.3,
  "Current_mA": 12.3,
  "Power_mW": 40.6,
  "ldrValue": 2100,
  "ldrAvailable": true,
  "isDark": false,
  "deviceOnline": true,
  "lastSeen": 1770000000,
  "footsteps": 4
}
```

Each `readings/{timestamp}` record supplies the chart and accumulated-energy data:

```json
{
  "timestamp": 1770000000,
  "Voltage_V": 3.3,
  "Current_mA": 12.3,
  "Power_mW": 40.6,
  "Vref_V": 3.3,
  "Direction": 0
}
```

The app integrates `Power_mW` over timestamp intervals, then displays energy in `µWh` below `1 mWh` and `mWh` at or above that threshold. Power displays similarly switch between `µW` and `mW` below and above `1 mW`. Display precision follows the study's reported precision: whole `µW`, one decimal `µWh`, three decimals `mW`, and four decimals `mWh`. The `steps/{timestamp}` records should contain a timestamp and an event count:

```json
{
  "timestamp": 1770000000,
  "count": 1
}
```

Example `telemetry/latest`:

```json
{
  "steps": 4,
  "mode": "Power Saving",
  "lastUpdate": 1770000000
}
```

Lighting control behavior:

- Demand is based on the number of detected steps in a rolling five-minute window.
- `NONE`: 0 steps; no new LED hold is scheduled.
- `LOW`: 1-20 steps; a nighttime step starts or extends the LED hold to at least 8 seconds.
- `MEDIUM`: 21-50 steps; a nighttime step starts or extends the LED hold to at least 15 seconds.
- `HIGH`: 51 or more steps; a nighttime step starts with a 20-second hold. Each subsequent step while demand remains `HIGH` adds 3 seconds to the remaining hold, capped at 30 seconds.
- A new step does not shorten an already longer active LED hold. Detected steps during daylight do not turn the LED on.
- The light turns off when the timer reaches zero.
- The controller should publish `ledHoldSeconds` and `ledRemainingSeconds` in `KineticGen` so the dashboard can show the timer state.

Example `telemetry/history` (list of entries):

```json
{
  "log-1": {
    "id": "log-1",
    "timestamp": "...",
    "location": "Zone B",
    "energy": "0.38"
  },
  "log-2": {
    "id": "log-2",
    "timestamp": "...",
    "location": "Zone C",
    "energy": "0.41"
  }
}
```

## What to do next (Beginner Friendly)

1. Start with the dashboard working locally.
2. Enter your Firebase keys in `.env`.
3. Push test data into Firebase (you can do this in Firebase Console → Realtime Database → Data).
4. When you’re ready, connect the ESP32 to send data to Firebase.

If you want, tell me your ESP32 data format and I’ll make a ready-to-upload Arduino sketch.
