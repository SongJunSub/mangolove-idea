// RTL setup for the jsdom project: jest-dom matchers (toBeInTheDocument, etc.) and
// automatic DOM cleanup between tests so component tests don't leak into each other.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
