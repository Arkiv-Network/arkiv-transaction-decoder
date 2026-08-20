import {
  type Address,
  type Hex,
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  hexToBytes,
  parseAbi,
  parseAbiParameters,
  parseTransaction,
  toFunctionSelector,
} from "viem"

export const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044" as Address
export const BLOCK_TIME = 2 // seconds, assumed Arkiv block duration

// Mirrors @arkiv-network/sdk (src/entity/operations.ts, src/entity/params.ts, src/attr/codec.ts).
// A transaction is an atomic batch of entity operations, each one an operation tag plus the
// abi.encode of the struct that tag selects — a tagged union, so a new operation is additive
// rather than a change to execute() itself.
export const EXECUTE_ABI = parseAbi([
  "function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)",
])

export const EXECUTE_SELECTOR = toFunctionSelector(EXECUTE_ABI[0]) // 0x49650044

// The struct format the tagged union replaced. Blocks predating the switch still carry it, so both
// are decoded and the leading selector picks which.
// Operation struct: (uint8 operationType, bytes32 entityKey, bytes payload,
//   (bytes32[4] data) contentType, (bytes32 name, uint8 valueType, bytes32[4] value)[] attributes,
//   uint32 expiresAt, address newOwner)
export const LEGACY_EXECUTE_ABI = [
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

export const LEGACY_EXECUTE_SELECTOR = toFunctionSelector(LEGACY_EXECUTE_ABI[0]) // 0xba8ccf92

/**
 * Operation tags. The tagged union kept the numbering of the struct format, so an `operationType`
 * means the same thing whichever format it came from; the SDK spells 2/3/4 as patch, extendExpiry
 * and transferOwnership, which stay `update`/`extend`/`transfer` here so the names consumers
 * already store do not move under them. `expire` is what the engine does when an entity lapses and
 * never appears in a batch.
 */
export enum EntityOperationType {
  Create = 1,
  Update = 2,
  Extend = 3,
  Transfer = 4,
  Delete = 5,
  Expire = 6,
}

/** The `valueType` byte of a legacy attribute. */
export enum AttributeValueType {
  Uint = 1,
  String = 2,
  EntityKey = 3,
}

/**
 * Attribute `typeId`s of the current format, as @arkiv-network/sdk (src/attr/types.ts) defines
 * them. They are consensus-critical — written into entity records and mixed into index keys — so
 * this table must not drift from the node's. `Tombstone` is not a type: it marks an attribute
 * being unset, carries a zero-length value, and is legal only in a patch.
 */
export enum AttributeTypeId {
  Tombstone = 0,
  Bool = 1,
  I32 = 2,
  U64 = 3,
  U256 = 4,
  Dec = 5,
  Bytes32 = 6,
  Bytes = 7,
  Str = 8,
  Addr = 9,
  Key = 10,
}

const ATTRIBUTE_TYPE_NAMES: Record<number, string> = {
  [AttributeTypeId.Tombstone]: "tombstone",
  [AttributeTypeId.Bool]: "bool",
  [AttributeTypeId.I32]: "i32",
  [AttributeTypeId.U64]: "u64",
  [AttributeTypeId.U256]: "u256",
  [AttributeTypeId.Dec]: "dec",
  [AttributeTypeId.Bytes32]: "bytes32",
  [AttributeTypeId.Bytes]: "bytes",
  [AttributeTypeId.Str]: "str",
  [AttributeTypeId.Addr]: "addr",
  [AttributeTypeId.Key]: "key",
}

const OPERATION_NAMES: Record<number, string> = {
  [EntityOperationType.Create]: "create",
  [EntityOperationType.Update]: "update",
  [EntityOperationType.Extend]: "extend",
  [EntityOperationType.Transfer]: "transfer",
  [EntityOperationType.Delete]: "delete",
  [EntityOperationType.Expire]: "expire",
}

/**
 * The entity payload and its content type have no operation fields of their own any more: they
 * travel as the system attributes `$payload` (the one `bytes`-typed cell) and `$contentType` (a
 * `str`). Both are lifted back out into the response fields of the same name, so an operation
 * reads the same way whichever format it arrived in.
 */
const PAYLOAD_CELL = "$payload"
const CONTENT_TYPE_CELL = "$contentType"

/** Decimal places a `dec` value is scaled by, fixed by the protocol. */
const DECIMAL_SCALE = 18

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// The `operationData` struct each tag selects, spelled as the SDK spells it.
const ATTRIBUTE_TUPLE = "(bytes32 name, uint8 typeId, bytes value)[]"

const CREATE_PARAMS = parseAbiParameters(
  `(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, ${ATTRIBUTE_TUPLE} attributes)`,
)
const PATCH_PARAMS = parseAbiParameters(`(bytes32 entityKey, ${ATTRIBUTE_TUPLE} mutations)`)
const EXTEND_PARAMS = parseAbiParameters("(bytes32 entityKey, uint64 expiresAt, uint64 minLifetime)")
const TRANSFER_PARAMS = parseAbiParameters("(bytes32 entityKey, address newOwner)")
const DELETE_PARAMS = parseAbiParameters("(bytes32 entityKey)")

export class DecodeError extends Error {}

export type DecodedAttribute = {
  key: string
  valueType: number
  /** legacy: "uint" | "string" | "entityKey"; current: the SDK type tag, e.g. "str" or "u64" */
  valueTypeName: string
  value: string
}

export type DecodedOperation = {
  operationType: number
  operation: string
  /** null for a create: the engine derives the key from owner, nonce and salt, which calldata alone does not carry */
  entityKey: Hex | null
  /** Size only in the current format — an entity's payload bytes are never returned. */
  payload: { size: number; hex?: Hex; text?: string }
  contentType: string | null
  attributes: DecodedAttribute[]
  /** the block count to store: the lifetime asked for, or the absolute deadline when that is all the operation gave */
  expiresAtBlocks: number
  /** expiresAtBlocks converted with the assumed 2s block time; informational only */
  approxExpiresInSeconds: number
  newOwner: Address | null
  /** current format: the absolute deadline as a block height, 0 when unset */
  expiresAt?: number
  /** current format: the lifetime floor in blocks, counted from the block the transaction lands in, 0 when unset */
  minLifetime?: number
  /** create only: the uint128 salt mixed into the entity key, as a decimal string */
  salt?: string
  /** create only: the flags byte fixing the entity as readonly (bit 0) and permissionlessly extensible (bit 1) */
  creationFlags?: number
}

export type DecodedTransaction = {
  functionName: "execute"
  /** which execute() encoding the calldata used */
  format: "tagged" | "legacy"
  /** present when a full serialized transaction (not bare calldata) was supplied */
  to?: Address | null
  /** set when `to` is present and differs from the known Arkiv registry address */
  warning?: string
  operations: DecodedOperation[]
}

// bytes32[4] container holding a left-aligned, zero-padded byte string (Mime128 / legacy string values)
function decodeBytes128(parts: readonly [Hex, Hex, Hex, Hex]): Uint8Array {
  const buf = new Uint8Array(128)
  parts.forEach((part, i) => buf.set(hexToBytes(part), i * 32))
  let end = buf.length
  while (end > 0 && buf[end - 1] === 0) end--
  return buf.slice(0, end)
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

function byteLength(value: Hex): number {
  return (value.length - 2) / 2
}

function decodeLegacyAttribute(attr: {
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
      return { key, valueType: attr.valueType, valueTypeName: "string", value: decodeUtf8(bytes) ?? attr.value.join("") }
    }
    case AttributeValueType.EntityKey:
      return { key, valueType: attr.valueType, valueTypeName: "entityKey", value: attr.value[0] }
    default:
      return { key, valueType: attr.valueType, valueTypeName: "unknown", value: attr.value.join("") }
  }
}

/** A `dec` word: an int256 holding the value scaled by 10**18, rendered back as its decimal literal. */
function formatDecimal(units: bigint): string {
  const sign = units < 0n ? "-" : ""
  const digits = (units < 0n ? -units : units).toString().padStart(DECIMAL_SCALE + 1, "0")
  const fraction = digits.slice(-DECIMAL_SCALE).replace(/0+$/, "")
  const whole = digits.slice(0, -DECIMAL_SCALE)
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}

/**
 * Renders an attribute value as text, following its declared `typeId` — the word types as the
 * number or address they encode, `str` as its UTF-8 text, and `bytes` as a size alone. `bytes` is
 * the system-only type backing `$payload`, so rendering the bytes themselves would put entity
 * payloads into responses and logs.
 */
function decodeAttributeValue(typeId: number, value: Hex): string {
  if (typeId === AttributeTypeId.Tombstone) return ""
  if (typeId === AttributeTypeId.Bytes) return `<${byteLength(value)} bytes>`
  const bytes = hexToBytes(value)
  if (typeId === AttributeTypeId.Str) return decodeUtf8(bytes) ?? value
  // Every remaining type is exactly one word. Anything else is malformed, and is reported as its
  // raw hex rather than reinterpreted into a number it never held.
  if (bytes.length !== 32) return value
  const word = BigInt(value)
  switch (typeId) {
    case AttributeTypeId.Bool:
      return word === 0n ? "false" : "true"
    case AttributeTypeId.I32:
      return BigInt.asIntN(32, word).toString()
    case AttributeTypeId.U64:
    case AttributeTypeId.U256:
      return word.toString()
    case AttributeTypeId.Dec:
      return formatDecimal(BigInt.asIntN(256, word))
    case AttributeTypeId.Addr:
      return getAddress(`0x${value.slice(-40)}`)
    default:
      // bytes32, key, and any type this build does not know yet
      return value.toLowerCase()
  }
}

type AbiAttribute = { name: Hex; typeId: number; value: Hex }

type OperationCells = {
  attributes: DecodedAttribute[]
  payloadSize: number
  contentType: string | null
}

/**
 * Splits an operation's attribute array into the two system cells the response carries as fields
 * of their own and the attributes proper.
 */
function readAttributeCells(cells: readonly AbiAttribute[]): OperationCells {
  const attributes: DecodedAttribute[] = []
  let payloadSize = 0
  let contentType: string | null = null

  for (const cell of cells) {
    const key = decodeIdent32(cell.name)
    if (key === PAYLOAD_CELL) {
      payloadSize = byteLength(cell.value)
      continue
    }
    if (key === CONTENT_TYPE_CELL) {
      const text = decodeAttributeValue(cell.typeId, cell.value)
      contentType = text.length > 0 ? text : null
      continue
    }
    attributes.push({
      key,
      valueType: cell.typeId,
      valueTypeName: ATTRIBUTE_TYPE_NAMES[cell.typeId] ?? "unknown",
      value: decodeAttributeValue(cell.typeId, cell.value),
    })
  }

  return { attributes, payloadSize, contentType }
}

/**
 * A uint64 block count as a JSON number, clamped rather than rendered imprecisely: an entity
 * created to never expire carries 2**64-1, which no double holds exactly and which overflows the
 * BIGINT column a consumer stores it in.
 */
function toBlockCount(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
}

/** The expiry pair the wire carries, plus the single block count a consumer stores. */
function expiryFields(expiresAt: bigint, minLifetime: bigint) {
  const lifetime = toBlockCount(minLifetime)
  const deadline = toBlockCount(expiresAt)
  return {
    // A lifetime in blocks is what the legacy field held, so it wins; an operation that gave only
    // an absolute deadline has nothing else to report there.
    expiresAtBlocks: lifetime > 0 ? lifetime : deadline,
    approxExpiresInSeconds: lifetime * BLOCK_TIME,
    expiresAt: deadline,
    minLifetime: lifetime,
  }
}

/** Decode one entry of the tagged union: the tag says which struct `operationData` holds. */
function decodeTaggedOperation(op: { operation: number; operationData: Hex }): DecodedOperation {
  const operationType = op.operation
  const operation = OPERATION_NAMES[operationType] ?? `unknown(${operationType})`
  const base: DecodedOperation = {
    operationType,
    operation,
    entityKey: null,
    payload: { size: 0 },
    contentType: null,
    attributes: [],
    expiresAtBlocks: 0,
    approxExpiresInSeconds: 0,
    newOwner: null,
    expiresAt: 0,
    minLifetime: 0,
  }

  try {
    switch (operationType) {
      case EntityOperationType.Create: {
        const [create] = decodeAbiParameters(CREATE_PARAMS, op.operationData)
        const cells = readAttributeCells(create.attributes)
        return {
          ...base,
          ...expiryFields(create.expiresAt, create.minLifetime),
          payload: { size: cells.payloadSize },
          contentType: cells.contentType,
          attributes: cells.attributes,
          salt: create.salt.toString(),
          creationFlags: create.creationFlags,
        }
      }
      case EntityOperationType.Update: {
        const [patch] = decodeAbiParameters(PATCH_PARAMS, op.operationData)
        const cells = readAttributeCells(patch.mutations)
        return {
          ...base,
          entityKey: patch.entityKey,
          payload: { size: cells.payloadSize },
          contentType: cells.contentType,
          attributes: cells.attributes,
        }
      }
      case EntityOperationType.Extend: {
        const [extend] = decodeAbiParameters(EXTEND_PARAMS, op.operationData)
        return {
          ...base,
          entityKey: extend.entityKey,
          ...expiryFields(extend.expiresAt, extend.minLifetime),
        }
      }
      case EntityOperationType.Transfer: {
        const [transfer] = decodeAbiParameters(TRANSFER_PARAMS, op.operationData)
        return { ...base, entityKey: transfer.entityKey, newOwner: transfer.newOwner }
      }
      case EntityOperationType.Delete: {
        const [remove] = decodeAbiParameters(DELETE_PARAMS, op.operationData)
        return { ...base, entityKey: remove.entityKey }
      }
      default:
        // A tag this build does not know. Report it as such rather than rejecting the batch, so
        // the operations around it are still decoded.
        return base
    }
  } catch (e) {
    throw new DecodeError(
      `Operation data of a ${operation} operation does not decode: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/** Decode current-format `execute(...)` calldata. */
export function decodeTaggedCalldata(data: Hex): DecodedTransaction {
  let args
  try {
    ;({ args } = decodeFunctionData({ abi: EXECUTE_ABI, data }))
  } catch (e) {
    throw new DecodeError(
      `Data is not a valid Arkiv execute() call: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  return {
    functionName: "execute",
    format: "tagged",
    operations: args[0].map(decodeTaggedOperation),
  }
}

/** Decode legacy struct-format `execute(...)` calldata. */
export function decodeLegacyCalldata(data: Hex): DecodedTransaction {
  let args
  try {
    ;({ args } = decodeFunctionData({ abi: LEGACY_EXECUTE_ABI, data }))
  } catch (e) {
    throw new DecodeError(
      `Data is not a valid legacy Arkiv execute() call: ${e instanceof Error ? e.message : String(e)}`,
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
      attributes: op.attributes.map(decodeLegacyAttribute),
      expiresAtBlocks: op.expiresAt,
      approxExpiresInSeconds: op.expiresAt * BLOCK_TIME,
      newOwner: op.newOwner.toLowerCase() === ZERO_ADDRESS ? null : op.newOwner,
    }
  })

  return { functionName: "execute", format: "legacy", operations }
}

function selectorOf(data: Hex): string {
  return data.slice(0, 10).toLowerCase()
}

/** Decode `execute(...)` calldata of either format, chosen by the leading selector. */
export function decodeCalldata(data: Hex): DecodedTransaction {
  const selector = selectorOf(data)
  if (selector === EXECUTE_SELECTOR) return decodeTaggedCalldata(data)
  if (selector === LEGACY_EXECUTE_SELECTOR) return decodeLegacyCalldata(data)
  throw new DecodeError(
    `Data is not an Arkiv execute() call: selector ${selector} is neither ${EXECUTE_SELECTOR} ` +
      `nor the legacy ${LEGACY_EXECUTE_SELECTOR}`,
  )
}

function isHexString(input: string): input is Hex {
  return /^0x[0-9a-fA-F]*$/.test(input)
}

function isExecuteCalldata(data: Hex): boolean {
  const selector = selectorOf(data)
  return selector === EXECUTE_SELECTOR || selector === LEGACY_EXECUTE_SELECTOR
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

  if (isExecuteCalldata(trimmed)) {
    return decodeCalldata(trimmed)
  }

  // Not raw calldata — try interpreting it as a serialized transaction.
  let tx
  try {
    tx = parseTransaction(trimmed)
  } catch {
    throw new DecodeError(
      `Data is neither Arkiv execute() calldata (selector ${EXECUTE_SELECTOR}, or ` +
        `${LEGACY_EXECUTE_SELECTOR} in the legacy format) nor a parseable serialized transaction`,
    )
  }

  if (!tx.data || !isExecuteCalldata(tx.data)) {
    throw new DecodeError(
      `Serialized transaction does not call Arkiv execute() (selector ${EXECUTE_SELECTOR}, or ` +
        `${LEGACY_EXECUTE_SELECTOR} in the legacy format)`,
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
