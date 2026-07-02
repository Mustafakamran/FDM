import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver; BrowsePane's list virtualization uses one to
// track the scroll container's height. A no-op stub is enough for tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
