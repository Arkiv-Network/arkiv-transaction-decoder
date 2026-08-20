/** Byte and word helpers both ABI generations share. */
import { type Hex, hexToBytes } from "viem"

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export function trimTrailingZeros(bytes: Uint8Array): Uint8Array {
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  return bytes.slice(0, end)
}

// Ident32: string left-aligned in a single bytes32, null-padded on the right.
export function decodeIdent32(name: Hex): string {
  const bytes = trimTrailingZeros(hexToBytes(name))
  return decodeUtf8(bytes) ?? name
}

export function isHexString(input: string): input is Hex {
  return /^0x[0-9a-fA-F]*$/.test(input)
}
