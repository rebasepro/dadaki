// Lightweight, dependency-free analytics dispatcher.
//
// The core editor emits events through `logAppEvent`. It knows nothing about
// Firebase (or any backend) — the app layer registers a single sink at init
// via `registerAnalyticsSink` to forward events wherever it likes. This keeps
// the core clean and makes analytics trivially swappable / testable.

export type AnalyticsSink = (eventName: string, eventParams?: Record<string, any>) => void;

let sink: AnalyticsSink | null = null;

/**
 * Wire the analytics backend. Call once, early, at app init.
 * Passing `null` disables analytics (e.g. in tests).
 */
export function registerAnalyticsSink(next: AnalyticsSink | null): void {
    sink = next;
}

/**
 * Emit an analytics event.
 *
 * @param eventName   e.g. 'document_created', 'export_completed'
 * @param eventParams optional context for the event
 */
export function logAppEvent(eventName: string, eventParams?: Record<string, any>): void {
    sink?.(eventName, eventParams);
}
