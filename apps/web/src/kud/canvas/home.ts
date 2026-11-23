/**
 * Kud Code: the canvas is the home screen, so a server welcome never moves the app from `/` into
 * the bootstrap thread (upstream does that in `routes/__root.tsx`).
 */
export const KUD_CANVAS_IS_HOME: boolean = true;
