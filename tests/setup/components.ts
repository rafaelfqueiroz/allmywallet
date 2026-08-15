import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

// vitest-axe's own `extend-expect` entry targets Vitest 0.x and silently fails
// to register against Vitest 4 — the matcher then surfaces as "Invalid Chai
// property: toHaveNoViolations". Registering it by hand is the whole fix.
expect.extend(axeMatchers);

// The same version gap costs us the types: vitest-axe's declarations augment
// Vitest 0.x's `Assertion`, not Vitest 4's `Matchers`. Declared here so the
// matcher is typed at the call sites rather than asserted away with `any`.
declare module 'vitest' {
  // DV-02 bans `any`, and this is the one place it cannot be avoided: TypeScript
  // merges an interface only when the type parameters match *exactly*, defaults
  // included, and Vitest declares `Matchers<T = any>`. `unknown` here fails with
  // TS2428 rather than producing a safer type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toHaveNoViolations(): T;
  }
}

afterEach(cleanup);

/*
 * jsdom implements the DOM but neither layout nor the pointer-capture APIs.
 * Radix's Dialog, Select and Tabs use both, so without these stubs the
 * primitives *throw* rather than fail an assertion — which reads as a broken
 * test rather than a broken component. These are the minimum set.
 *
 * DL-09 records the corresponding limit: jsdom has no paint, so this harness
 * proves structure, aria and keyboard behaviour, never contrast. Contrast is
 * PR3's Playwright baselines.
 */

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = function hasPointerCapture() {
    return false;
  };
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
}
