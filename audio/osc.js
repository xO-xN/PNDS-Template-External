import { pathToFileURL } from 'node:url'

const shared = process.env.PNDS_SHARED_LIBRARIES
  ? JSON.parse(process.env.PNDS_SHARED_LIBRARIES)['osc-min']
  : null
if (
  process.env.PNDS_SHARED_LIBRARIES &&
  (!shared?.path || shared.version !== '2.1.2')
)
  throw new Error('Missing exact shared osc-min 2.1.2 entry')
export const osc = await import(
  shared ? pathToFileURL(shared.path).href : 'osc-min'
)

export function encodeOsc(address, args) {
  const view = osc.toBuffer({ address, args })
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}
