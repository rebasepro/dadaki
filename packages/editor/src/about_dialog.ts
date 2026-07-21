/**
 * AboutDialog — modal showing application info and credits.
 */

// The Dadaki paper-boat mark (8 mirrored facets), fitted into a 100×100 tile.
// Inlined so the editor stays self-contained; matches the app's public/logo.svg.
const MARK =
    '<g transform="matrix(1,0,0,1,95.89219665527344,45.415000915527344)"><path d="M 31.668594 -13.285 C 34.1886 -16.585001 30.8386 -21.125 26.9486 -19.685001 C 26.9486 -19.685001 -7.893402 -7.415001 -7.893402 -7.415001 C -7.893402 -7.415001 -31.678604 2.0694008 -31.678604 2.0694008 C -31.678604 2.0694008 5.858597 19.684998 5.858597 19.684998 C 6.4285965 19.404999 6.948601 19.015 7.3485947 18.494999 C 7.3485947 18.494999 8.418594 17.094997 8.418594 17.094997 C 8.418594 17.094997 31.678596 -13.285 31.678596 -13.285 C 31.678596 -13.285 31.668594 -13.285 31.668594 -13.285 Z" /></g><g transform="matrix(1,0,0,1,32.561893463134766,45.409996032714844)"><path d="M 7.436901 -7.409996 C 7.436901 -7.409996 -26.960798 -19.679996 -26.960798 -19.679996 C -30.8508 -21.119995 -34.2108 -16.579996 -31.6908 -13.279995 C -31.6908 -13.279995 -7.3608 18.490005 -7.3608 18.490005 C -6.9607983 19.010002 -6.450798 19.400002 -5.870798 19.68 C -5.870798 19.68 -5.063099 19.590004 -5.063099 19.590004 C -5.063099 19.590004 31.6908 2.0705032 31.6908 2.0705032 C 31.6908 2.0705032 7.436901 -7.409996 7.436901 -7.409996 Z" /></g><g transform="matrix(1,0,0,1,103.164794921875,32.099998474121094)"><path d="M -14.843143 5.773513 C -14.843143 5.773513 19.666 -6.369999 19.666 -6.369999 C 19.666 -6.369999 -18.827255 -1.0737379 -18.794094 -1.1093599 Z" /></g><g transform="matrix(1,0,0,1,25.29994010925293,32.099998474121094)"><path d="M 18.615618 -0.8174885 C 18.615618 -0.8174885 -19.698856 -6.369999 -19.698856 -6.369999 C -19.698856 -6.369999 14.765357 6.1326976 14.819644 6.0152655 Z" /></g><g transform="matrix(1,0,0,1,82.93584442138672,58.62999725341797)"><path d="M -18.714752 -11.149998 C -18.714752 -11.149998 -18.804947 4.834404 -18.804947 4.834404 C -18.804947 4.834404 -18.714752 11.150002 -18.714752 11.150002 C -18.714752 11.150002 17.49495 6.8700027 17.49495 6.8700027 C 17.954948 6.8199997 18.39495 6.670006 18.804947 6.470001 C 18.804947 6.470001 6.4752502 0.6800041 6.4752502 0.6800041 C 6.4752502 0.6800041 -18.714752 -11.149998 -18.714752 -11.149998 Z" /></g><g transform="matrix(1,0,0,1,45.466094970703125,58.619998931884766)"><path d="M 18.754997 -11.139999 C 18.754997 -11.139999 -18.765001 6.4699974 -18.765001 6.4699974 C -18.355 6.670002 -17.915 6.8200035 -17.445 6.869999 C -17.445 6.869999 18.765 11.149998 18.765 11.149998 C 18.765 11.149998 18.765 -11.149998 18.765 -11.149998 C 18.765 -11.149998 18.754997 -11.139999 18.754997 -11.139999 Z" /></g><g transform="matrix(1,0,0,1,76.18839263916016,23.748050689697266)"><path d="M 12.055984 14.137625 C 12.055984 14.137625 8.392601 7.581949 8.392601 7.581949 C 8.392601 7.581949 -7.2974014 -20.97805 -7.2974014 -20.97805 C -8.307396 -22.82805 -10.137398 -23.74805 -11.9674 -23.74805 C -11.9674 -23.74805 -12.312599 -0.087150574 -12.312599 -0.087150574 C -12.312599 -0.087150574 -11.9674 23.74805 -11.9674 23.74805 C -11.9674 23.74805 12.120771 14.137625 12.120771 14.137625 Z" /></g><g transform="matrix(1,0,0,1,52.076194763183594,23.739999771118164)"><path d="M 12.144997 23.74 C 12.144997 23.74 12.144997 -23.74 12.144997 -23.74 C 10.314999 -23.74 8.485001 -22.82 7.4749985 -20.98 C 7.4749985 -20.98 3.8250008 -14.33 3.8250008 -14.33 C 3.8250008 -14.33 -6.3149986 4.130001 -6.3149986 4.130001 C -6.3149986 4.130001 -8.136084 7.560802 -8.136084 7.560802 C -8.136084 7.560802 -11.903319 14.361931 -11.916653 14.375264 Z" /></g>';

export class AboutDialog {
    private overlay: HTMLElement;

    constructor() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';
        this.overlay.style.display = 'none';
        this.build();
        document.body.appendChild(this.overlay);

        // Click on the backdrop (not the card) closes.
        this.overlay.addEventListener('click', (e: MouseEvent) => {
            if (e.target === this.overlay) this.close();
        });
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.isOpen()) this.close();
        });
    }

    private build(): void {
        const card = document.createElement('div');
        card.className = 'modal-card about-card';
        card.addEventListener('click', (e: MouseEvent) => e.stopPropagation());

        card.innerHTML = `
            <div class="about-logo">
                <svg width="52" height="52" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="Dadaki">
                    <defs>
                        <linearGradient id="about-dadaki-tile" x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">
                            <stop stop-color="#242424" />
                            <stop offset="1" stop-color="#141414" />
                        </linearGradient>
                    </defs>
                    <rect x="1" y="1" width="98" height="98" rx="22" fill="url(#about-dadaki-tile)" stroke="#ffffff" stroke-opacity="0.14" stroke-width="1.5" />
                    <g transform="translate(11.92 28.68) scale(0.61122)" fill="none" stroke="#f4f4f4" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
                        <g transform="matrix(0.9680989980697632,0,0,0.9680988788604736,0.12952375411987305,1.113027811050415)">${MARK}</g>
                    </g>
                </svg>
            </div>
            <div class="about-title">Dadaki Vector Editor</div>
            <div class="about-tagline">Professional In-Browser SVG Graphics Editor</div>

            <div class="about-divider"></div>

            <div class="about-credit">
                Done with care by
                <a href="https://rebase.pro" target="_blank" rel="noopener noreferrer" class="about-link">rebase.pro</a>
            </div>
            <div class="about-contact">
                <a href="mailto:hello@rebase.pro" class="about-email">hello@rebase.pro</a>
            </div>
            <div class="about-legal">
                <a href="/privacy" target="_blank" rel="noopener noreferrer" class="about-link">Privacy Policy</a>
                <span class="about-legal-sep">·</span>
                <a href="/terms" target="_blank" rel="noopener noreferrer" class="about-link">Terms of Service</a>
            </div>

            <div class="modal-actions about-actions">
                <button class="header-btn header-btn-primary" id="about-close">Close</button>
            </div>
        `;
        this.overlay.appendChild(card);

        (card.querySelector('#about-close') as HTMLButtonElement).addEventListener('click', () =>
            this.close(),
        );
    }

    open(): void {
        this.overlay.style.display = 'flex';
    }

    close(): void {
        this.overlay.style.display = 'none';
    }

    private isOpen(): boolean {
        return this.overlay.style.display !== 'none';
    }
}
