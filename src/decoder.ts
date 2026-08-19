import {
  type Address,
  type Hex,
  decodeFunctionData,
  getAddress,
  hexToBytes,
  parseTransaction,
  toFunctionSelector,
  toHex,
} from "viem"

// Mirrors @arkiv-network/sdk (src/utils/arkivTransactions.ts, src/consts.ts).
// Operation struct: (uint8 operationType, bytes32 entityKey, bytes payload,
//   (bytes32[4] data) contentType, (bytes32 name, uint8 valueType, bytes32[4] value)[] attributes,
//   uint32 expiresAt, address newOwner)
export const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044" as Address
export const BLOCK_TIME = 2 // seconds, assumed Arkiv block duration

export const ENTITY_EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "ops",
        type: "tuple[]",
        components: [
          { name: "operationType", type: "uint8" },
          { name: "entityKey", type: "bytes32" },
          { name: "payload", type: "bytes" },
          {
            name: "contentType",
            type: "tuple",
            components: [{ name: "data", type: "bytes32[4]" }],
          },
          {
            name: "attributes",
            type: "tuple[]",
            components: [
              { name: "name", type: "bytes32" },
              { name: "valueType", type: "uint8" },
              { name: "value", type: "bytes32[4]" },
            ],
          },
          { name: "expiresAt", type: "uint32" },
          { name: "newOwner", type: "address" },
        ],
      },
    ],
    outputs: [],
  },
] as const

export const EXECUTE_SELECTOR = toFunctionSelector(ENTITY_EXECUTE_ABI[0])

export enum EntityOperationType {
  Create = 1,
  Update = 2,
  Extend = 3,
  Transfer = 4,
  Delete = 5,
  Expire = 6,
}

export enum AttributeValueType {
  Uint = 1,
  String = 2,
  EntityKey = 3,
}

const OPERATION_NAMES: Record<number, string> = {
  [EntityOperationType.Create]: "create",
  [EntityOperationType.Update]: "update",
  [EntityOperationType.Extend]: "extend",
  [EntityOperationType.Transfer]: "transfer",
  [EntityOperationType.Delete]: "delete",
  [EntityOperationType.Expire]: "expire",
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export class DecodeError extends Error {}

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
  /** present when a full serialized transaction (not bare calldata) was supplied */
  to?: Address | null
  /** set when `to` is present and differs from the known Arkiv registry address */
  warning?: string
  operations: DecodedOperation[]
}

// bytes32[4] container holding a left-aligned, zero-padded byte string (Mime128 / string attribute values)
function decodeBytes128(parts: readonly [Hex, Hex, Hex, Hex]): Uint8Array {
  const buf = new Uint8Array(128)
  parts.forEach((part, i) => buf.set(hexToBytes(part), i * 32))
  let end = buf.length
  while (end > 0 && buf[end - 1] === 0) end--
  return buf.slice(0, end)
}

// The four words hold one 128-byte string, so the fallback hex-encodes them once.
// Joining the four 0x-prefixed words would produce a string that is not valid hex.
function packedHex(parts: readonly [Hex, Hex, Hex, Hex]): Hex {
  const buf = new Uint8Array(128)
  parts.forEach((part, i) => buf.set(hexToBytes(part), i * 32))
  return toHex(buf)
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

// Ident32: string left-aligned in a single bytes32
function decodeIdent32(name: Hex): string {
  const bytes = hexToBytes(name)
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  return decodeUtf8(bytes.slice(0, end)) ?? name
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

function isHexString(input: string): input is Hex {
  return /^0x[0-9a-fA-F]*$/.test(input)
}

/** Decode `execute(...)` calldata into Arkiv operations. */
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
      operation: OPERATION_NAMES[op.operationType] ?? `unknown(${op.operationType})`,
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

/**
 * Decode either bare `execute(...)` calldata or a full RLP-serialized transaction
 * (signed or unsigned) whose data is an Arkiv execute() call.
 */
export function decodeArkivTransaction(input: string): DecodedTransaction {
  const trimmed = input.trim()
  if (!isHexString(trimmed)) {
    throw new DecodeError("Input must be a 0x-prefixed hex string")
  }

  if (trimmed.toLowerCase().startsWith(EXECUTE_SELECTOR)) {
    return decodeCalldata(trimmed)
  }

  // Not raw calldata — try interpreting it as a serialized transaction.
  let tx
  try {
    tx = parseTransaction(trimmed)
  } catch {
    throw new DecodeError(
      `Data is neither Arkiv execute() calldata (selector ${EXECUTE_SELECTOR}) nor a parseable serialized transaction`,
    )
  }

  if (!tx.data || !tx.data.toLowerCase().startsWith(EXECUTE_SELECTOR)) {
    throw new DecodeError(
      `Serialized transaction does not call Arkiv execute() (selector ${EXECUTE_SELECTOR})`,
    )
  }

  const decoded = decodeCalldata(tx.data)
  const to = tx.to ? getAddress(tx.to) : null
  decoded.to = to
  if (to && to.toLowerCase() !== ARKIV_ADDRESS.toLowerCase()) {
    decoded.warning = `Transaction target ${to} is not the known Arkiv registry ${ARKIV_ADDRESS}`
  }
  return decoded
}
