/**
 * File I/O for .dadaki (protobuf) and .svg formats.
 * Uses the File System Access API for native save/open dialogs, with a
 * blob-download / <input type=file> fallback for browsers that lack it
 * (Firefox, Safari).
 *
 * This module is intentionally stateless: file handles and document identity
 * live on the Document / DocumentManager, not here. Callers pass the handle to
 * reuse (or null to force a picker) and receive back the handle that was
 * actually used so they can persist it.
 */
import type { Engine } from '../engine/pkg/engine';

/** Outcome of a save. `handle` is null when the download fallback was used. */
export interface SaveResult {
    handle: FileSystemFileHandle | null;
}

/** Outcome of an open. `handle` is null when the <input> fallback was used. */
export interface OpenResult {
    handle: FileSystemFileHandle | null;
    name: string;
}

/** True when the native File System Access API is available. */
export function hasFileSystemAccess(): boolean {
    return 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
}

/**
 * A native (protobuf) document — `.dadaki`. `.svg` is not native: it imports and
 * must be re-saved via Save As.
 */
export function isNativeDoc(name: string): boolean {
    return /\.dadaki$/i.test(name);
}

export class FileIO {
    /**
     * Save the current scene to `handle` if given (save-in-place); otherwise
     * show a Save As dialog. Returns the handle used, or `null` on user-abort
     * so the caller can leave dirty state untouched.
     */
    static async saveDadaki(
        engine: Engine,
        handle: FileSystemFileHandle | null,
        suggestedName = 'untitled.dadaki',
    ): Promise<SaveResult | null> {
        const bytes = engine.serialize_proto();

        if (handle) {
            await FileIO.writeToHandle(handle, bytes);
            return { handle };
        }
        return FileIO.saveDadakiAs(engine, suggestedName);
    }

    /**
     * Save As — always shows the picker (or downloads on fallback).
     * Returns null on user-abort.
     */
    static async saveDadakiAs(
        engine: Engine,
        suggestedName = 'untitled.dadaki',
    ): Promise<SaveResult | null> {
        const bytes = engine.serialize_proto();

        if ('showSaveFilePicker' in window) {
            try {
                const handle = await (window as any).showSaveFilePicker({
                    suggestedName,
                    types: [
                        {
                            description: 'Dadaki Document',
                            accept: { 'application/octet-stream': ['.dadaki'] },
                        },
                    ],
                });
                await FileIO.writeToHandle(handle, bytes);
                return { handle };
            } catch (e: unknown) {
                if (e instanceof DOMException && e.name === 'AbortError') return null;
                // Fall through to download fallback
            }
        }

        FileIO.downloadBlob(new Uint8Array(bytes), suggestedName, 'application/octet-stream');
        return { handle: null };
    }

    /**
     * Show an open dialog for .dadaki / .svg. Loads the picked file into `engine`
     * and returns its handle + name, or null on abort / load failure.
     */
    static async openFile(
        engine: Engine,
        fallbackParser?: (svgText: string) => void,
    ): Promise<OpenResult | null> {
        if ('showOpenFilePicker' in window) {
            try {
                const [handle] = await (window as any).showOpenFilePicker({
                    types: [
                        {
                            description: 'Dadaki or SVG files',
                            accept: {
                                'application/octet-stream': ['.dadaki'],
                                'image/svg+xml': ['.svg'],
                            },
                        },
                    ],
                    multiple: false,
                });

                const file = await handle.getFile();
                const loaded = await FileIO.loadFile(engine, file, fallbackParser);
                if (!loaded) return null;
                // Only native documents get a reusable save-in-place handle; an
                // imported .svg should save to a new .dadaki via Save As.
                const isNative = isNativeDoc(file.name);
                return { handle: isNative ? handle : null, name: file.name };
            } catch (e: unknown) {
                if (e instanceof DOMException && e.name === 'AbortError') return null;
            }
        }

        return FileIO.openViaInput(engine, fallbackParser);
    }

    /**
     * Show an open dialog and return the picked file + handle WITHOUT loading
     * it. Lets the caller create/activate the target document first, so an SVG
     * import (which parses into the active engine) lands in the new tab.
     */
    static async pickFile(): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
        if ('showOpenFilePicker' in window) {
            try {
                const [handle] = await (window as any).showOpenFilePicker({
                    types: [
                        {
                            description: 'Dadaki or SVG files',
                            accept: {
                                'application/octet-stream': ['.dadaki'],
                                'image/svg+xml': ['.svg'],
                            },
                        },
                    ],
                    multiple: false,
                });
                const file = await handle.getFile();
                return { file, handle };
            } catch (e: unknown) {
                if (e instanceof DOMException && e.name === 'AbortError') return null;
            }
        }

        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.dadaki,.svg';
            input.onchange = () => {
                const file = input.files?.[0];
                resolve(file ? { file, handle: null } : null);
            };
            input.click();
        });
    }

    /**
     * Load a file (auto-detect native .dadaki vs .svg).
     */
    static async loadFile(
        engine: Engine,
        file: File,
        fallbackParser?: (svgText: string) => void,
    ): Promise<boolean> {
        if (isNativeDoc(file.name)) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            return engine.deserialize_proto(bytes);
        }

        // SVG: check for embedded protobuf payload
        const text = await file.text();
        return FileIO.loadSVGText(engine, text, fallbackParser);
    }

    /**
     * Parse SVG text and load it. Checks for an embedded dadaki:data payload first.
     * If no payload is found and a fallback parser callback is provided, it is called with the raw SVG text.
     */
    static loadSVGText(
        engine: Engine,
        text: string,
        fallbackParser?: (svgText: string) => void,
    ): boolean {
        // Check for an embedded protobuf payload.
        const match = text.match(/<dadaki:data[^>]*>([\s\S]*?)<\/dadaki:data>/);
        if (match) {
            const b64 = match[1].trim();
            if (engine.deserialize_proto_base64(b64)) {
                return true;
            }
        }

        // Fallback to standard SVG parsing via UI parser
        if (fallbackParser) {
            fallbackParser(text);
            return true;
        }

        console.warn(
            'No dadaki:data payload found in SVG. Standard SVG import not yet implemented.',
        );
        return false;
    }

    /**
     * Export SVG with embedded protobuf payload.
     * Takes the SVG string from the existing export and injects the payload.
     */
    static embedPayloadInSVG(engine: Engine, svgContent: string): string {
        const b64 = engine.serialize_proto_base64();

        // Inject the namespace and metadata right after the opening <svg> tag
        const svgWithNs = svgContent.replace(
            '<svg xmlns="http://www.w3.org/2000/svg"',
            '<svg xmlns="http://www.w3.org/2000/svg"\n     xmlns:dadaki="https://dadaki.dev/ns"',
        );

        // Insert metadata block right after the opening tag
        const closingBracket = svgWithNs.indexOf('>');
        if (closingBracket === -1) return svgContent;

        const before = svgWithNs.slice(0, closingBracket + 1);
        const after = svgWithNs.slice(closingBracket + 1);

        return (
            before +
            `\n  <metadata>\n    <dadaki:data version="${engine.get_format_version()}">\n${b64}\n    </dadaki:data>\n  </metadata>` +
            after
        );
    }

    // ─── Private Helpers ────────────────────────────────────────────────────

    private static async writeToHandle(
        handle: FileSystemFileHandle,
        data: Uint8Array | number[],
    ): Promise<void> {
        const writable = await (handle as any).createWritable();
        await writable.write(data instanceof Uint8Array ? data : new Uint8Array(data));
        await writable.close();
    }

    private static downloadBlob(data: Uint8Array, filename: string, mime: string): void {
        const blob = new Blob(
            [data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer],
            { type: mime },
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    private static openViaInput(
        engine: Engine,
        fallbackParser?: (svgText: string) => void,
    ): Promise<OpenResult | null> {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.dadaki,.svg';
            input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) {
                    resolve(null);
                    return;
                }
                const loaded = await FileIO.loadFile(engine, file, fallbackParser);
                resolve(loaded ? { handle: null, name: file.name } : null);
            };
            input.click();
        });
    }
}
