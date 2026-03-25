import { describe, it, expect } from 'vitest';
import {
  isDesktopLikeTouch,
  shouldAutoFocusTerminal,
  shouldRestoreTerminalFocusAfterSearchClose,
  shouldShowMobileToolbar,
} from '../src/web/focusPolicy.js';

function env(overrides: Partial<{
  userAgent: string;
  viewportWidth: number;
  hasTouchStart: boolean;
  maxTouchPoints: number;
}> = {}) {
  return {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    viewportWidth: 1280,
    hasTouchStart: false,
    maxTouchPoints: 0,
    ...overrides,
  };
}

describe('shouldAutoFocusTerminal', () => {
  it('returns true on non-touch environments', () => {
    expect(shouldAutoFocusTerminal(env())).toBe(true);
  });

  it('returns false on touch-capable devices', () => {
    expect(shouldAutoFocusTerminal(env({ hasTouchStart: true }))).toBe(false);
    expect(shouldAutoFocusTerminal(env({ maxTouchPoints: 5 }))).toBe(false);
  });
});

describe('isDesktopLikeTouch', () => {
  it('returns true for Surface-like wide desktop touch environments', () => {
    expect(isDesktopLikeTouch(env({ hasTouchStart: true, maxTouchPoints: 10, viewportWidth: 1280 }))).toBe(true);
  });

  it('returns false for touch devices on narrow screens', () => {
    expect(isDesktopLikeTouch(env({ hasTouchStart: true, maxTouchPoints: 10, viewportWidth: 600 }))).toBe(false);
  });

  it('returns false for mobile user agents', () => {
    expect(
      isDesktopLikeTouch(
        env({
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
          hasTouchStart: true,
          maxTouchPoints: 5,
          viewportWidth: 1024,
        }),
      ),
    ).toBe(false);
  });
});

describe('shouldShowMobileToolbar', () => {
  it('shows on mobile UA', () => {
    expect(
      shouldShowMobileToolbar(
        env({
          userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36',
          hasTouchStart: true,
          maxTouchPoints: 5,
          viewportWidth: 1200,
        }),
      ),
    ).toBe(true);
  });

  it('hides on wide Surface desktop touch', () => {
    expect(shouldShowMobileToolbar(env({ hasTouchStart: true, maxTouchPoints: 10, viewportWidth: 1280 }))).toBe(false);
  });

  it('shows on narrow touch screens even with desktop UA', () => {
    expect(shouldShowMobileToolbar(env({ hasTouchStart: true, maxTouchPoints: 10, viewportWidth: 700 }))).toBe(true);
  });
});

describe('shouldRestoreTerminalFocusAfterSearchClose', () => {
  it('does not restore focus on Surface-like wide desktop touch', () => {
    expect(
      shouldRestoreTerminalFocusAfterSearchClose(
        env({ hasTouchStart: true, maxTouchPoints: 10, viewportWidth: 1280 }),
      ),
    ).toBe(false);
  });

  it('restores focus on non-touch desktop', () => {
    expect(shouldRestoreTerminalFocusAfterSearchClose(env())).toBe(true);
  });
});
