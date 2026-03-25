export interface FocusPolicyEnv {
  userAgent: string;
  viewportWidth: number;
  hasTouchStart: boolean;
  maxTouchPoints: number;
}

const MOBILE_UA_REGEX =
  /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i;

export function isTouchCapable(env: FocusPolicyEnv): boolean {
  const isTouch = env.hasTouchStart || env.maxTouchPoints > 0;
  return isTouch;
}

export function isMobileUA(env: FocusPolicyEnv): boolean {
  return MOBILE_UA_REGEX.test(env.userAgent);
}

export function isDesktopLikeTouch(env: FocusPolicyEnv): boolean {
  return isTouchCapable(env) && !isMobileUA(env) && env.viewportWidth >= 768;
}

export function shouldAutoFocusTerminal(env: FocusPolicyEnv): boolean {
  const isTouch = isTouchCapable(env);
  return !isTouch;
}

export function shouldRestoreTerminalFocusAfterSearchClose(env: FocusPolicyEnv): boolean {
  return !isDesktopLikeTouch(env);
}

export function shouldShowMobileToolbar(env: FocusPolicyEnv): boolean {
  const isTouch = isTouchCapable(env);
  const isSmallScreen = env.viewportWidth < 768;

  return isMobileUA(env) || (isTouch && isSmallScreen);
}
