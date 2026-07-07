/**
 * TabStrip — renders the document tabs in the header.
 *
 * A pure view: it takes a list of tab descriptors and callbacks and renders
 * them. Phase A drives it with a single tab; Phase B's DocumentManager drives
 * it with many. Rendering is signature-guarded so it can be called on every
 * mutation (for the dirty dot) without thrashing the DOM.
 */

export interface TabDescriptor {
    id: string;
    name: string;
    dirty: boolean;
    active: boolean;
}

export interface TabStripCallbacks {
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
    onRename?: (id: string, name: string) => void;
}

export class TabStrip {
    private _signature = '';

    constructor(private el: HTMLElement, private cb: TabStripCallbacks) {}

    render(tabs: TabDescriptor[]): void {
        const sig = tabs.map(t => `${t.id}:${t.name}:${t.dirty ? 1 : 0}:${t.active ? 1 : 0}`).join('|')
            + `#${tabs.length}`;
        if (sig === this._signature) return;
        this._signature = sig;

        this.el.innerHTML = '';
        const showClose = tabs.length > 1;

        for (const t of tabs) {
            const tab = document.createElement('div');
            tab.className = 'doc-tab' + (t.active ? ' active' : '');
            tab.title = t.name;

            const label = document.createElement('span');
            label.className = 'doc-tab-label';
            label.textContent = t.name;

            const dot = document.createElement('span');
            dot.className = 'doc-tab-dot' + (t.dirty ? ' dirty' : '');

            tab.appendChild(dot);
            tab.appendChild(label);

            if (showClose) {
                const close = document.createElement('button');
                close.className = 'doc-tab-close';
                close.innerHTML = '&times;';
                close.title = 'Close';
                close.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.cb.onClose(t.id);
                });
                tab.appendChild(close);
            }

            tab.addEventListener('click', () => this.cb.onSelect(t.id));
            tab.addEventListener('mousedown', (e) => {
                // Middle-click closes.
                if (e.button === 1 && showClose) {
                    e.preventDefault();
                    this.cb.onClose(t.id);
                }
            });
            if (this.cb.onRename) {
                tab.addEventListener('dblclick', () => this.beginRename(label, t));
            }

            this.el.appendChild(tab);
        }

        const add = document.createElement('button');
        add.className = 'doc-tab-add';
        add.innerHTML = '+';
        add.title = 'New document (⌥⌘N)';
        add.addEventListener('click', () => this.cb.onNew());
        this.el.appendChild(add);
    }

    private beginRename(label: HTMLElement, t: TabDescriptor): void {
        const input = document.createElement('input');
        input.className = 'doc-tab-rename';
        input.value = t.name;
        label.replaceWith(input);
        input.focus();
        input.select();

        const commit = () => {
            const v = input.value.trim();
            if (v && v !== t.name) this.cb.onRename?.(t.id, v);
            // Force a re-render next time by clearing the signature.
            this._signature = '';
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            else if (e.key === 'Escape') { input.value = t.name; input.blur(); }
            e.stopPropagation();
        });
    }
}
