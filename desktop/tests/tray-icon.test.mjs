import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { resolveTrayImage } from '../main/tray-icon.mjs'

/** Records which asset was requested and answers the NativeImage surface the adapter uses. */
function nativeImageFixture({ empty = false } = {}) {
  const requested = []
  let template = false
  return {
    requested,
    get template() { return template },
    createFromPath(path) {
      requested.push(path)
      return {
        isEmpty: () => empty,
        getSize: () => ({ width: 18, height: 18 }),
        setTemplateImage(value) { template = value },
        isTemplateImage: () => template,
      }
    },
  }
}

// A synthetic absolute root: the adapter must not depend on any real host location.
const assetsDirectory = '/novawing-test-assets/desktop/assets'

// macOS menu-bar items must be template images, or the system draws a solid block that
// cannot follow the light/dark menu bar.
test('darwin selects the template asset and marks it as a template image', () => {
  const nativeImage = nativeImageFixture()
  const { image, diagnostics } = resolveTrayImage({ nativeImage, assetsDirectory, platform: 'darwin' })
  assert.equal(diagnostics.asset, 'trayTemplate.png')
  assert.equal(nativeImage.requested[0], join(assetsDirectory, 'trayTemplate.png'))
  assert.equal(diagnostics.templateImage, true)
  assert.deepEqual(image.getSize(), { width: 18, height: 18 })
  assert.deepEqual(diagnostics, { platform: 'darwin', asset: 'trayTemplate.png',
    imageEmpty: false, imageWidth: 18, imageHeight: 18, templateImage: true })
})

test('win32 keeps the existing full-colour asset and is never marked as a template', () => {
  const nativeImage = nativeImageFixture()
  const { diagnostics } = resolveTrayImage({ nativeImage, assetsDirectory, platform: 'win32' })
  assert.equal(diagnostics.asset, 'tray.png')
  assert.equal(nativeImage.requested[0], join(assetsDirectory, 'tray.png'))
  assert.equal(diagnostics.templateImage, false)
  assert.equal(nativeImage.template, false, 'Windows tray behaviour must stay unchanged')
})

test('an unreadable asset is reported instead of silently presented as a tray icon', () => {
  const nativeImage = nativeImageFixture({ empty: true })
  const { diagnostics } = resolveTrayImage({ nativeImage, assetsDirectory, platform: 'darwin' })
  assert.equal(diagnostics.imageEmpty, true)
  assert.equal(diagnostics.templateImage, false, 'nothing may be marked a template when it failed to load')
})

test('the resolved asset path stays inside the packaged assets directory', () => {
  const nativeImage = nativeImageFixture()
  resolveTrayImage({ nativeImage, assetsDirectory, platform: 'darwin' })
  assert.ok(isAbsolute(nativeImage.requested[0]))
})
