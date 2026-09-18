import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Mirrors the native targets in the installed @openai/codex-sdk 0.151.0. */
const targetTriples: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

export function codexRuntimeTarget(platform: string, arch: string): {
  packageName: string; triple: string; binaryName: string
} {
  const target = `${platform}-${arch}`
  const triple = targetTriples[target]
  if (triple === undefined) {
    throw Object.assign(new Error(`Unsupported Codex Local host: ${platform}/${arch}`), { code: 'configuration_error' })
  }
  return { packageName: `@openai/codex-${target}`, triple, binaryName: platform === 'win32' ? 'codex.exe' : 'codex' }
}

/** Resolve only the native package owned by the SDK's CLI dependency. No PATH fallback. */
export function bundledCodexExecutable(): string {
  const target = codexRuntimeTarget(process.platform, process.arch)
  try {
    const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'))
    const cliRequire = createRequire(sdkRequire.resolve('@openai/codex/package.json'))
    const root = dirname(cliRequire.resolve(`${target.packageName}/package.json`))
    const nativeRoot = join(root, 'vendor', target.triple)
    const executable = join(nativeRoot, 'bin', target.binaryName)
    // The pinned SDK's native package layout includes both this manifest and bin/.
    if (!statSync(join(nativeRoot, 'codex-package.json')).isFile() || !statSync(executable).isFile()) {
      throw new Error('Codex native package is incomplete')
    }
    return executable
  } catch (cause) {
    throw Object.assign(new Error(`Bundled Codex runtime unavailable for ${process.platform}/${process.arch}`, { cause }), {
      code: 'configuration_error',
    })
  }
}
