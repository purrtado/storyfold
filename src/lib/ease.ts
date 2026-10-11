// Shared motion tokens from beUI (beui.dev). Easing curves mirror the CSS
// custom properties in index.css; springs are the canonical physics used
// across adapted components.

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Press feedback on buttons and other tappable surfaces. */
export const SPRING_PRESS = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.6,
} as const;
