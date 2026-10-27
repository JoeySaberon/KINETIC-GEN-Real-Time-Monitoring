import { initializeApp } from "firebase/app";
import {
    endAt,
    get,
    getDatabase,
    limitToFirst,
    orderByChild,
    query,
    ref,
    update,
} from "firebase/database";
import {
    getAuth,
    browserLocalPersistence,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    sendEmailVerification,
    onAuthStateChanged,
    reload,
    setPersistence,
    signInWithEmailAndPassword,
    signOut,
} from "firebase/auth";

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const hasConfig = Object.values(firebaseConfig).every((value) => Boolean(value));
const CLEARED_NODE_KEY = "__dashboardCleared";

export const firebaseConfigError = hasConfig
    ? ""
    : "Firebase configuration is incomplete. Check the VITE_FIREBASE_* values in .env and restart Vite.";

export const firebaseReady = hasConfig;

export const firebaseApp = hasConfig ? initializeApp(firebaseConfig) : null;

export const firebaseDb = hasConfig ? getDatabase(firebaseApp) : null;
export const firebaseAuth = hasConfig ? getAuth(firebaseApp) : null;
export const authPersistenceReady = firebaseAuth
    ? setPersistence(firebaseAuth, browserLocalPersistence)
    : Promise.resolve();
const accountCreationApp = hasConfig
    ? initializeApp(firebaseConfig, "account-creation")
    : null;
const accountCreationAuth = accountCreationApp ? getAuth(accountCreationApp) : null;

export const AUTH_EMAIL = "joeysaberon8@gmail.com";
export const OWNER_EMAIL = AUTH_EMAIL;

export const waitForAuthState = () =>
    new Promise((resolve) => {
        if (!firebaseAuth) {
            resolve(null);
            return;
        }

        const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
            unsubscribe();
            resolve(user);
        });
    });

export const signInFirebaseUser = async (email, password) => {
    if (!firebaseAuth) {
        throw new Error("Firebase Auth is not configured.");
    }

    await authPersistenceReady;
    const credentials = await signInWithEmailAndPassword(firebaseAuth, email, password);
    if (!credentials.user.emailVerified) {
        await signOut(firebaseAuth);
        const error = new Error("Please verify your email before signing in.");
        error.code = "auth/email-not-verified";
        throw error;
    }

    return credentials;
};

export const createFirebaseUser = async (email, password) => {
    if (!accountCreationAuth) {
        throw new Error("Firebase Auth is not configured.");
    }

    const credentials = await createUserWithEmailAndPassword(accountCreationAuth, email, password);
    await sendEmailVerification(credentials.user);
    await signOut(accountCreationAuth);
    return credentials.user;
};

export const refreshFirebaseUser = async () => {
    if (!firebaseAuth?.currentUser) {
        return null;
    }

    await reload(firebaseAuth.currentUser);
    return firebaseAuth.currentUser;
};

export const sendFirebasePasswordReset = async (email) => {
    if (!firebaseAuth) {
        throw new Error("Firebase Auth is not configured.");
    }

    return sendPasswordResetEmail(firebaseAuth, email);
};

export const signOutFirebaseUser = async () => {
    if (!firebaseAuth) {
        return;
    }

    await signOut(firebaseAuth);
};

export const clearFirebaseTelemetry = async () => {
    if (!firebaseDb) {
        throw new Error("Firebase Database is not configured.");
    }

    const [readingsSnapshot, stepsSnapshot] = await Promise.all([
        get(ref(firebaseDb, "readings")),
        get(ref(firebaseDb, "steps")),
    ]);
    const deletes = {
        [`KineticGen/${CLEARED_NODE_KEY}`]: true,
        "KineticGen/Current_mA": 0,
        "KineticGen/Power_mW": 0,
        "KineticGen/Voltage_V": 0,
        "KineticGen/currentStep": 0,
        "KineticGen/deviceOnline": false,
        "KineticGen/footsteps": 0,
        "KineticGen/isDark": false,
        "KineticGen/lastSeen": 0,
        "KineticGen/lastStepAt": 0,
        "KineticGen/ldrAvailable": false,
        "KineticGen/ldrValue": 0,
        "KineticGen/ledStatus": false,
        "KineticGen/piezoADC": 0,
        "KineticGen/piezoJump": 0,
        "telemetry/history": null,
        "telemetry/latest": null,
        [`telemetry/${CLEARED_NODE_KEY}`]: true,
        [`readings/${CLEARED_NODE_KEY}`]: true,
        [`steps/${CLEARED_NODE_KEY}`]: true,
    };

    for (const key of Object.keys(readingsSnapshot.val() || {})) {
        if (key !== CLEARED_NODE_KEY) {
            deletes[`readings/${key}`] = null;
        }
    }
    for (const key of Object.keys(stepsSnapshot.val() || {})) {
        if (key !== CLEARED_NODE_KEY) {
            deletes[`steps/${key}`] = null;
        }
    }

    await update(ref(firebaseDb), deletes);
};

export const clearFirebaseHistory = async (clearedAt = Date.now()) => {
    if (!firebaseDb) {
        throw new Error("Firebase Database is not configured.");
    }

    await update(ref(firebaseDb), {
        [`telemetry/${CLEARED_NODE_KEY}`]: true,
        "telemetry/history": null,
        "telemetry/historyClearedAt": clearedAt,
    });
};

export const cleanupFirebaseTelemetry = async (
    cutoff = Date.now() - 24 * 60 * 60 * 1000,
    batchSize = 200,
) => {
    if (!firebaseDb) {
        throw new Error("Firebase Database is not configured.");
    }

    const cutoffSeconds = Math.floor(cutoff / 1000);
    const [readingsSnapshot, stepsSnapshot] = await Promise.all([
        get(
            query(
                ref(firebaseDb, "readings"),
                orderByChild("timestamp"),
                endAt(cutoffSeconds),
                limitToFirst(batchSize),
            ),
        ),
        get(
            query(
                ref(firebaseDb, "steps"),
                orderByChild("timestamp"),
                endAt(cutoffSeconds),
                limitToFirst(batchSize),
            ),
        ),
    ]);

    const deletes = {};
    for (const [key] of Object.entries(readingsSnapshot.val() || {})) {
        if (key !== CLEARED_NODE_KEY) {
            deletes[`readings/${key}`] = null;
        }
    }
    for (const [key] of Object.entries(stepsSnapshot.val() || {})) {
        if (key !== CLEARED_NODE_KEY) {
            deletes[`steps/${key}`] = null;
        }
    }

    if (Object.keys(deletes).length > 0) {
        await update(ref(firebaseDb), deletes);
    }

    return Object.keys(deletes).length;
};

export const updateFirebaseTileMetadata = async (metadata) => {
    if (!firebaseDb) {
        throw new Error("Firebase Database is not configured.");
    }

    await update(ref(firebaseDb, "KineticGen"), metadata);
};
