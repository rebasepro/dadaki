/**
 * File I/O for .vec (protobuf) and .svg formats.
 * Uses the File System Access API for native save/open dialogs.
 */
import type { Engine } from '../engine/pkg/engine';

export class FileIO {
    /** Currently open file handle (for Cmd+S "save in place"). */
    private static fileHandle: FileSystemFileHandle | null = null;

    /**
     * Save the current scene as a .vec file.
     * If a file is already open, overwrites it. Otherwise shows Save As dialog.
     */
    static async saveVec(engine: Engine): Promise<void> {
        const bytes = engine.serialize_proto();

        if (this.fileHandle) {
            await this.writeToHandle(this.fileHandle, bytes);
            return;
        }

        // Show Save As dialog
        await this.saveVecAs(engine);
    }

    /**
     * Save As — always shows dialog.
     */
    static async saveVecAs(engine: Engine): Promise<void> {
        const bytes = engine.serialize_proto();

        if ('showSaveFilePicker' in window) {
            try {
                const handle = await (window as any).showSaveFilePicker({
                    suggestedName: 'untitled.vec',
                    types: [{
                        description: 'Vector Document',
                        accept: { 'application/octet-stream': ['.vec'] },
                    }],
                });
                await this.writeToHandle(handle, bytes);
                this.fileHandle = handle;
                document.title = handle.name + ' — Vector Editor';
                return;
            } catch (e: unknown) {
                if (e instanceof DOMException && e.name === 'AbortError') return;
                // Fall through to download fallback
            }
        }

        // Fallback: download via blob
        this.downloadBlob(new Uint8Array(bytes), 'untitled.vec', 'application/octet-stream');
    }

    /**
     * Open a .vec or .svg file.
     * Returns true if a file was loaded.
     */
    static async openFile(engine: Engine): Promise<boolean> {
        if ('showOpenFilePicker' in window) {
            try {
                const [handle] = await (window as any).showOpenFilePicker({
                    types: [{
                        description: 'Vector or SVG files',
                        accept: {
                            'application/octet-stream': ['.vec'],
                            'image/svg+xml': ['.svg'],
                        },
                    }],
                    multiple: false,
                });

                const file = await handle.getFile();
                const loaded = await this.loadFile(engine, file);
                if (loaded && file.name.endsWith('.vec')) {
                    this.fileHandle = handle;
                    document.title = file.name + ' — Vector Editor';
                }
                return loaded;
            } catch (e: unknown) {
                if (e instanceof DOMException && e.name === 'AbortError') return false;
            }
        }

        // Fallback: file input
        return this.openViaInput(engine);
    }

    /**
     * Load a file (auto-detect .vec vs .svg).
     */
    static async loadFile(engine: Engine, file: File): Promise<boolean> {
        if (file.name.endsWith('.vec')) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            return engine.deserialize_proto(bytes);
        }

        // SVG: check for embedded protobuf payload
        const text = await file.text();
        return this.loadSVGText(engine, text);
    }

    /**
     * Parse SVG text and load it. Checks for embedded vec:data payload first.
     */
    static loadSVGText(engine: Engine, text: string): boolean {
        // Check for embedded protobuf payload
        const match = text.match(/<vec:data[^>]*>([\s\S]*?)<\/vec:data>/);
        if (match) {
            const b64 = match[1].trim();
            if (engine.deserialize_proto_base64(b64)) {
                return true;
            }
        }

        // TODO: Fallback to standard SVG parsing
        console.warn('No vec:data payload found in SVG. Standard SVG import not yet implemented.');
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
            '<svg xmlns="http://www.w3.org/2000/svg"\n     xmlns:vec="https://vector-editor.dev/ns"'
        );

        // Insert metadata block right after the opening tag
        const closingBracket = svgWithNs.indexOf('>');
        if (closingBracket === -1) return svgContent;

        const before = svgWithNs.slice(0, closingBracket + 1);
        const after = svgWithNs.slice(closingBracket + 1);

        return before +
            `\n  <metadata>\n    <vec:data version="${engine.get_format_version()}">\n${b64}\n    </vec:data>\n  </metadata>` +
            after;
    }

    // ─── Private Helpers ────────────────────────────────────────────────────

    private static async writeToHandle(handle: FileSystemFileHandle, data: Uint8Array | number[]): Promise<void> {
        const writable = await (handle as any).createWritable();
        await writable.write(data instanceof Uint8Array ? data : new Uint8Array(data));
        await writable.close();
    }

    private static downloadBlob(data: Uint8Array, filename: string, mime: string): void {
        const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    private static openViaInput(engine: Engine): Promise<boolean> {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.vec,.svg';
            input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) {
                    resolve(false);
                    return;
                }
                const loaded = await this.loadFile(engine, file);
                resolve(loaded);
            };
            input.click();
        });
    }
}
