// App-layer analytics backend: wires Firebase Analytics to the core's
// analytics dispatcher. This is the ONLY module that imports Firebase.
//
// The config values are NOT secret — Firebase ships them in the client
// bundle by design. They live in .env for per-environment config and to keep
// them out of source control; access is enforced by Firebase Security Rules /
// App Check, not by hiding this config.

import type { AnalyticsSink } from '@dadaki/editor';
import { type Analytics, getAnalytics, logEvent } from 'firebase/analytics';
import { initializeApp } from 'firebase/app';

const firebaseConfig = {
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

/**
 * Initialize Firebase and return a sink to hand to `registerAnalyticsSink`.
 * Safe to call in non-browser contexts — analytics simply stays disabled if
 * `getAnalytics` is unsupported.
 */
export function createFirebaseAnalyticsSink(): AnalyticsSink {
    const app = initializeApp(firebaseConfig);
    let analytics: Analytics | null = null;
    try {
        analytics = getAnalytics(app);
    } catch (error) {
        console.warn('Firebase Analytics could not be initialized:', error);
    }

    return (eventName, eventParams) => {
        if (analytics) {
            logEvent(analytics, eventName, eventParams);
        }
        if (import.meta.env.DEV) {
            const tag = analytics ? 'Analytics' : 'Analytics - NOT INITIALIZED';
            console.log(`[${tag}] Event: ${eventName}`, eventParams || {});
        }
    };
}
