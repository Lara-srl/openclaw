/**
 * Ada UI State Protocol — SET_UI frames for the device display.
 *
 * The device firmware (future Step 4) will render visual states on the
 * 412x412 display. Current firmware silently ignores unknown frame types.
 */

export const AdaUiState = {
  BOOT: 0,
  IDLE: 100,
  LISTENING: 200,
  THINKING: 300,
  ACTING: 400,
  SPEAKING: 500,
  COMPACTION: 600,
  SHUTDOWN: 900,
} as const;

export type AdaUiStateCode = (typeof AdaUiState)[keyof typeof AdaUiState];

export function buildUiState(
  state: AdaUiStateCode,
  opts: { text?: string; icon?: string; brightness?: number } = {},
): string {
  return JSON.stringify({
    type: "SET_UI",
    state,
    ...(opts.text !== undefined && { text: opts.text }),
    ...(opts.icon !== undefined && { icon: opts.icon }),
    brightness: opts.brightness ?? 255,
  });
}

export function buildEyeColor(hexColor: string): string {
  return JSON.stringify({ type: "SET_EYE_COLOR", hex_color: hexColor });
}
