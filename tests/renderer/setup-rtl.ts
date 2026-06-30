// RTL setup for the jsdom project: jest-dom matchers (toBeInTheDocument, etc.) and
// automatic DOM cleanup between tests so component tests don't leak into each other.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no ResizeObserver; components that construct one on mount (Split, the terminal)
// would throw. A noop stub lets them mount — jsdom has no real layout so the observer would
// never fire anyway, and tests that need re-clamp behavior exercise the pure math directly.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

afterEach(() => {
  cleanup();
});
