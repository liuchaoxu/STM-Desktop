/**
 * Rasterize a short string into a PNG data URL, for shaders that take an image
 * (`MetallicPaint` samples a texture and uses its alpha as the shape mask).
 *
 * Two details that matter for the metallic treatment:
 *   - the glyphs must **not** be pure white: `MetallicPaint`'s image processing
 *     treats `rgb(255,255,255)` as background (it is written for white-background
 *     logos), which would erase the whole wordmark;
 *   - the source colours are not used by the shader beyond the mask (it derives
 *     its own depth field), so a flat off-white is enough.
 */
export interface TextImageOptions {
  /** Glyph size in px. */
  fontSize?: number
  fontFamily?: string
  fontWeight?: string | number
  padding?: number
  color?: string
}

export function textToDataUrl(text: string, options: TextImageOptions = {}): string {
  const {
    fontSize = 110,
    fontFamily = 'system-ui, "Segoe UI", Roboto, sans-serif',
    fontWeight = 700,
    padding = 16,
    color = '#e8e8e8'
  } = options

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const font = `${fontWeight} ${fontSize}px ${fontFamily}`
  ctx.font = font
  const width = Math.ceil(ctx.measureText(text).width) + padding * 2
  const height = Math.ceil(fontSize * 1.3) + padding * 2

  canvas.width = width
  canvas.height = height
  // The 2D context resets when the canvas is resized.
  ctx.font = font
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, width / 2, height / 2)

  return canvas.toDataURL('image/png')
}
