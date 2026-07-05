import { Engine } from '../engine/pkg/engine';

export class PersistenceManager {
    private static DB_NAME = 'VectorEditorDB';
    private static STORE_NAME = 'scenes';
    private static KEY = 'current_scene';

    static async saveScene(engine: Engine) {
        const data = engine.serialize_proto();
        const db = await this.openDB();
        return new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.put(data, this.KEY);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    static async loadScene(engine: Engine) {
        const db = await this.openDB();
        return new Promise<void>((resolve) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.get(this.KEY);
            request.onsuccess = () => {
                const data = request.result;
                if (data) {
                    const ok = engine.deserialize_proto(data);
                    if (!ok) {
                        console.warn('[Persistence] Failed to deserialize saved scene – starting clean.');
                    }
                }
                resolve();
            };
            request.onerror = () => resolve();
        });
    }

    private static openDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore(this.STORE_NAME);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}

export class AutosaveManager {
    private timeout: ReturnType<typeof setTimeout> | null = null;
    private interval = 2000; // 2 seconds

    constructor(private engine: Engine) {}

    trigger() {
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = setTimeout(() => {
            PersistenceManager.saveScene(this.engine).catch(console.error);
        }, this.interval);
    }
}
