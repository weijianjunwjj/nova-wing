import { join } from 'node:path'

/**
 * Host status-bar image selection. This is the only place that knows how a tray image must
 * be presented on a given host; the shared Tray lifecycle stays platform-free.
 *
 * macOS menu-bar items are template images: the system reads the alpha channel and inverts
 * the glyph for light and dark menu bars. A full-colour, fully opaque bitmap is drawn as a
 * solid block instead of a glyph, and cannot follow the menu-bar appearance.
 *
 * @typedef {object} TrayImageDiagnostics
 * @property {string} platform
 * @property {string} asset
 * @property {boolean} imageEmpty
 * @property {number} imageWidth
 * @property {number} imageHeight
 * @property {boolean} templateImage
 */

/**
 * @param {{
 *   nativeImage: { createFromPath(path: string): any },
 *   assetsDirectory: string,
 *   platform?: string,
 * }} options
 * @returns {{ image: any, diagnostics: TrayImageDiagnostics }}
 */
export function resolveTrayImage(options) {
  const platform = options.platform ?? process.platform
  const template = platform === 'darwin'
  const asset = template ? 'trayTemplate.png' : 'tray.png'
  const image = options.nativeImage.createFromPath(join(options.assetsDirectory, asset))
  // A retina variant is picked up automatically when `trayTemplate@2x.png` sits alongside.
  if (template && !image.isEmpty()) image.setTemplateImage(true)
  const size = image.getSize()
  return { image, diagnostics: {
    platform, asset, imageEmpty: image.isEmpty(), imageWidth: size.width, imageHeight: size.height,
    templateImage: image.isTemplateImage(),
  } }
}
