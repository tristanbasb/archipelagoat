// electron-builder afterPack hook (electron-builder.yml): the Linux launcher of the extracted tar.gz
// (build/linux/archipelagoat.sh) must be executable whatever mode the checkout gave its source, which a
// Windows checkout or a Docker mount does not keep. CommonJS: electron-builder requires its hooks.
/* eslint-disable @typescript-eslint/no-require-imports */
const { chmod } = require('node:fs/promises')
const path = require('node:path')

/** @param {{ electronPlatformName: string, appOutDir: string }} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return
  await chmod(path.join(context.appOutDir, 'archipelagoat.sh'), 0o755)
}
