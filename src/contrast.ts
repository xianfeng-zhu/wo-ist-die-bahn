// Readable badge text on an arbitrary line colour.
//
// Every badge used white text, because most VBB line colours are dark. But 47 of
// the 89 colours the app ships fail WCAG's 4.5:1 minimum against white, and the
// worst are unreadable rather than merely poor: U4 (#F0D722) scores 1.45:1 and
// RE2 (#FFD502) 1.42:1 — yellow with white writing on it.
//
// Choosing the text colour from the background's luminance fixes all of them at
// once and keeps working for a colour VBB adds later, which importing their
// published foreground colours would not.

/** WCAG relative luminance of a `#rrggbb` colour (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const channels = [0, 2, 4].map(i => {
    const v = parseInt(m[1].slice(i, i + 2), 16) / 255
    // sRGB gamma expansion, per WCAG 2.x
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

/** WCAG contrast ratio between two luminances, 1:1 to 21:1. */
export const contrastRatio = (a: number, b: number): number =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/**
 * Black or white, whichever reads better on `background`.
 *
 * The threshold is not 0.5: it is the luminance where the two ratios cross, which
 * for WCAG's formula is about 0.179. Splitting at 0.5 would leave mid-tones like
 * U6 (#8C6DAB) and S7 (#816DA6) on white text at 4.3-4.5:1, just under the
 * minimum, when black gives them 4.7-4.9:1.
 *
 * An unparseable colour returns white, matching the old fixed value.
 */
export function textOn(background: string): '#000000' | '#ffffff' {
  const bg = relativeLuminance(background)
  return contrastRatio(bg, 0) > contrastRatio(bg, 1) ? '#000000' : '#ffffff'
}
