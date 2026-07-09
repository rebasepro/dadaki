/**
 * AboutDialog — modal showing application info and credits.
 */
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
                <svg width="48" height="48" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                        <linearGradient id="about-dadaki-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stop-color="#7C3AED" />
                            <stop offset="100%" stop-color="#2563EB" />
                        </linearGradient>
                    </defs>
                    <rect width="32" height="32" rx="8" fill="url(#about-dadaki-grad)" />
                    <path d="M8 24C12 12 20 12 24 8" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" fill="none" />
                    <circle cx="8" cy="24" r="2" fill="#FFFFFF" />
                    <circle cx="24" cy="8" r="2.5" fill="#10B981" stroke="#FFFFFF" stroke-width="1.5" />
                    <path d="M14 14L18 18" stroke="#FFFFFF" stroke-dasharray="1.5,1.5" stroke-linecap="round" />
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
            
            <div class="modal-actions about-actions">
                <button class="header-btn header-btn-primary" id="about-close">Close</button>
            </div>
        `;
        this.overlay.appendChild(card);

        (card.querySelector('#about-close') as HTMLButtonElement)
            .addEventListener('click', () => this.close());
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
