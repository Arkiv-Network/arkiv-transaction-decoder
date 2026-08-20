/**
 * Generation-1 decoding. Existing callers still send this ABI, so it stays as it was.
 */
import { type Address, type Hex, decodeFunctionData, hexToBytes, toHex } from "viem"
import { AttributeValueType, ENTITY_EXECUTE_ABI, LEGACY_OPERATION_NAMES } from "./abi"
import { decodeIdent32, decodeUtf8, trimTrailingZeros } from "./bytes"
import { DecodeError } from "./gaps"

export const BLOCK_TIME = 2 // seconds, assumed Arkiv block duration

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export type DecodedAttribute = {
  key: string
  valueType: number
  valueTypeName: "uint" | "string" | "entityKey" | "unknown"
  value: string
}

export type DecodedOperation = {
  operationType: number
  operation: string
  entityKey: Hex
  payload: { hex: Hex; size: number; text?: string }
  contentType: string | null
  attributes: DecodedAttribute[]
  expiresAtBlocks: number
  /** expiresAtBlocks converted with the assumed 2s block time; informational only */
  approxExpiresInSeconds: number
  newOwner: Address | null
}

export type DecodedTransaction = {
  functionName: "execute"
  abi?: "legacy"
  selector?: Hex
  /** the call target when known: read from a serialized transaction, or given by the caller */
  to?: Address | null
  /** set when `to` is present and differs from the known Arkiv registry address */
  warning?: string
  operations: DecodedOperation[]
}

// bytes32[4] container holding a left-aligned, zero-padded byte string (Mime128 / string attribute values)
function decodeBytes128(parts: readonly [Hex, Hex, Hex, Hex]): Uint8Array {
  const buf = new Uint8Array(128)
  parts.forEach((part, i) => buf.set(hexToBytes(part), i * 32))
  return trimTrailingZeros(buf)
}

// The four words hold one 128-byte string, so the fallback hex-encodes them once.
// Joining the four 0x-prefixed words would produce a string that is not valid hex.
function packedHex(parts: readonly [Hex, Hex, Hex, Hex]): Hex {
  const buf = new Uint8Array(128)
  parts.forEach((part, i) => buf.set(hexToBytes(part), i * 32))
  return toHex(buf)
}

function decodeAttribute(attr: {
  name: Hex
  valueType: number
  value: readonly [Hex, Hex, Hex, Hex]
}): DecodedAttribute {
  const key = decodeIdent32(attr.name)
  switch (attr.valueType) {
    case AttributeValueType.Uint:
      // single bytes32, big-endian (right-aligned) integer
      return { key, valueType: attr.valueType, valueTypeName: "uint", value: BigInt(attr.value[0]).toString() }
    case AttributeValueType.String: {
      const bytes = decodeBytes128(attr.value)
      return {
        key,
        valueType: attr.valueType,
        valueTypeName: "string",
        value: decodeUtf8(bytes) ?? packedHex(attr.value),
      }
    }
    case AttributeValueType.EntityKey:
      return { key, valueType: attr.valueType, valueTypeName: "entityKey", value: attr.value[0] }
    default:
      return { key, valueType: attr.valueType, valueTypeName: "unknown", value: packedHex(attr.value) }
  }
}

/** Decode legacy `execute(...)` calldata into Arkiv operations. */
export function decodeCalldata(data: Hex): DecodedTransaction {
  let args
  try {
    ;({ args } = decodeFunctionData({ abi: ENTITY_EXECUTE_ABI, data }))
  } catch (e) {
    throw new DecodeError(
      `Data is not a valid Arkiv execute() call: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  const operations: DecodedOperation[] = args[0].map((op) => {
    const payloadBytes = hexToBytes(op.payload)
    const payloadText = payloadBytes.length > 0 ? decodeUtf8(payloadBytes) : undefined
    const contentTypeBytes = decodeBytes128(op.contentType.data)
    return {
      operationType: op.operationType,
      operation: LEGACY_OPERATION_NAMES[op.operationType] ?? `unknown(${op.operationType})`,
      entityKey: op.entityKey,
      payload: {
        hex: op.payload,
        size: payloadBytes.length,
        ...(payloadText !== undefined ? { text: payloadText } : {}),
      },
      contentType: contentTypeBytes.length > 0 ? (decodeUtf8(contentTypeBytes) ?? null) : null,
      attributes: op.attributes.map(decodeAttribute),
      expiresAtBlocks: op.expiresAt,
      approxExpiresInSeconds: op.expiresAt * BLOCK_TIME,
      newOwner: op.newOwner.toLowerCase() === ZERO_ADDRESS ? null : op.newOwner,
    }
  })

  return { functionName: "execute", operations }
}
