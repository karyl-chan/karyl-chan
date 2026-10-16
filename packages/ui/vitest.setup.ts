// Browser APIs jsdom doesn't implement but the components touch at
// mount time. Kept minimal; individual specs override when they need
// different behaviour (e.g. a mobile viewport).

if (typeof window.matchMedia !== 'function') {
    // Desktop by default — `useBreakpoint()` reads `(max-width: 768px)`.
    window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;
}

if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
}
