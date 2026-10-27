import {
  type Address,
  type Hex,
  decodeAbiParameters,
  decodeFunctionData,
  hexToBytes,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseTransaction,
  toFunctionSelector,
} from "viem"

export const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044" as Address

// Mirrors @arkiv-network/sdk 0.9 (src/entity/operations.ts, src/schema/codec.ts) and the node's
// execute() ABI (arkiv-state-db-experiment, crates/arkiv-node/src/signed/ethereum.rs). A
// transaction is an atomic batch of entity operations, each one an operation tag plus the
// abi.encode of the struct that tag selects.
export const EXECUTE_ABI = parseAbi([
  "function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)",
])

export const EXECUTE_SELECTOR = toFunctionSelector(EXECUTE_ABI[0]) // 0x49650044

/** The operation tags of the tagged union, named as the SDK and the node name them. */
export enum OperationType {
  Create = 1,
  Patch = 2,
  Extend = 3,
  Transfer = 4,
  Delete = 5,
}

const OPERATION_NAMES: Record<number, OperationName> = {
  [OperationType.Create]: "create",
  [OperationType.Patch]: "patch",
  [OperationType.Extend]: "extend",
  [OperationType.Transfer]: "transfer",
  [OperationType.Delete]: "delete",
}

/**
 * The type in the low seven bits of an attribute's `typeId`, as @arkiv-network/sdk
 * (src/schema/types.ts) and the node (`ArkivTypeId`) define them. Bit 7 is {@link INDEXED_FLAG}.
 * `Tombstone` is not a type: it is the whole `typeId` 0, the mutation that unsets an attribute,
 * carries a zero-length value and is legal only in a patch.
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

/** Bit 7 of `typeId`: the node indexes the attribute. Never set on `bytes` or a tombstone. */
export const INDEXED_FLAG = 0x80

/** The `expiresAt` of an entity that never expires: the largest uint64. */
export const PERMANENT_EXPIRES_AT = 2n ** 64n - 1n

/** The longest `str` value, in UTF-8 bytes. */
export const MAX_STR_BYTES = 128

/** The longest single `bytes` value. */
export const MAX_BYTES_LENGTH = 128 * 1024

export type AttributeType =
  | "bool"
  | "i32"
  | "u64"
  | "u256"
  | "dec"
  | "bytes32"
  | "bytes"
  | "str"
  | "addr"
  | "key"

const ATTRIBUTE_TYPES: Record<number, AttributeType> = {
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

/** Decimal places a `dec` value is scaled by, fixed by the protocol. */
const DECIMAL_SCALE = 18

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

/**
 * An attribute value in the encoding the node's `arkiv_query` returns for it, so the two compare
 * with plain equality: `bool` a JSON boolean, `i32` a JSON number, `u64`/`u256` a `0x` quantity,
 * `dec` its trimmed decimal literal, `str` its text, and `bytes32`/`key`/`addr` lowercase `0x`
 * hex. `null` for `bytes` (never returned), a tombstone and a triple that does not decode.
 */
export type AttributeValue = string | number | boolean | null

export type DecodedAttribute = {
  name: string
  /** the raw `typeId` byte, indexed flag included */
  typeId: number
  /** the type in the low seven bits; "tombstone" for typeId 0; "invalid(0x..)" for an id no build accepts */
  type: AttributeType | "tombstone" | `invalid(0x${string})`
  /** bit 7 of typeId */
  indexed: boolean
  value: AttributeValue
  /** length of the value bytes as calldata carries them: 32 for a word type, the UTF-8 length of a str */
  size: number
  /** `bytes` only: keccak256 of the content, which is never returned */
  keccak256?: Hex
  /** present only when the triple is malformed: what is wrong with it */
  error?: string
}

export type OperationName = "create" | "patch" | "extend" | "transfer" | "delete" | `unknown(${number})`

/**
 * One operation. Every operation carries every field, `null` where its tag has no such field, so a
 * consumer reads one shape whatever the tag.
 */
export type DecodedOperation = {
  operationType: number
  operation: OperationName
  /** null for a create: the engine derives the key from owner, nonce and salt, which calldata alone does not carry */
  entityKey: Hex | null
  /** create: the uint128 mixed into the entity key, as a decimal string */
  salt: string | null
  /** create: the flags byte, readonly (bit 0) and permissionless extension (bit 1) */
  creationFlags: number | null
  /** create, extend: the absolute deadline as a block height, as a decimal string; "0" when unset */
  expiresAt: string | null
  /** create, extend: the lifetime floor in blocks from the landing block, as a decimal string; "0" when unset */
  minLifetime: string | null
  /** create, extend: whether expiresAt is the permanent 2**64-1 */
  permanent: boolean | null
  /** transfer: the new owner, lowercase */
  newOwner: Address | null
  /** bytes held by the operation's `bytes` attributes together; 0 when it has none */
  bytesSize: number
  /** create: the attributes; patch: the mutations, tombstones included; otherwise empty */
  attributes: DecodedAttribute[]
}

export type DecodedTransaction = {
  functionName: "execute"
  /** the execute() encoding: the UDC (schema-typed attribute) model */
  format: "udc"
  /** present when a full serialized transaction (not bare calldata) was supplied; lowercase */
  to?: Address | null
  /** set when `to` is present and differs from the known Arkiv registry address */
  warning?: string
  operations: DecodedOperation[]
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function byteLength(value: Hex): number {
  return (value.length - 2) / 2
}

function hexByte(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(2, "0")}`
}

/** An Ident32 name: left-aligned, NUL-padded UTF-8. */
function decodeName(name: Hex): { name: string; error?: string } {
  const bytes = hexToBytes(name)
  let end = bytes.indexOf(0)
  if (end === -1) end = bytes.length
  const text = bytes.subarray(end).every((b) => b === 0) ? decodeUtf8(bytes.subarray(0, end)) : undefined
  if (text === undefined) {
    return { name: name.toLowerCase(), error: "the name is not NUL-padded UTF-8" }
  }
  return { name: text }
}

/** A `dec` word: an int256 holding the value scaled by 10**18, rendered back as its decimal literal. */
function formatDecimal(units: bigint): string {
  const sign = units < 0n ? "-" : ""
  const digits = (units < 0n ? -units : units).toString().padStart(DECIMAL_SCALE + 1, "0")
  const fraction = digits.slice(-DECIMAL_SCALE).replace(/0+$/, "")
  const whole = digits.slice(0, -DECIMAL_SCALE)
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

type ValueResult = { value: AttributeValue; error?: string }

function invalid(error: string): ValueResult {
  return { value: null, error }
}

/**
 * Decodes the value bytes of a word or `str` type with the strictness of the node's
 * `decode_abi_value`: what the node would refuse is reported as an error, never reinterpreted.
 */
function decodeValue(type: Exclude<AttributeType, "bytes">, value: Hex): ValueResult {
  const width = byteLength(value)
  if (type === "str") {
    if (width > MAX_STR_BYTES) return invalid(`a str value is at most ${MAX_STR_BYTES} bytes, got ${width}`)
    const text = decodeUtf8(hexToBytes(value))
    if (text === undefined) return invalid("a str value must be valid UTF-8")
    if (CONTROL_CHARACTER.test(text)) return invalid("a str value must not contain control characters")
    return { value: text }
  }

  if (width !== 32) return invalid(`a ${type} value must be 32 bytes, got ${width}`)
  const hex = value.toLowerCase() as Hex
  const word = BigInt(hex)
  switch (type) {
    case "bool":
      if (word > 1n) return invalid("a bool word must hold exactly 0 or 1")
      return { value: word === 1n }
    case "i32": {
      const narrowed = BigInt.asIntN(32, word)
      if (BigInt.asUintN(256, narrowed) !== word) return invalid("an i32 word must be sign-extended")
      return { value: Number(narrowed) }
    }
    case "u64":
      if (word >> 64n !== 0n) return invalid("a u64 word must be zero-padded to 8 bytes")
      return { value: `0x${word.toString(16)}` }
    case "u256":
      return { value: `0x${word.toString(16)}` }
    case "dec":
      return { value: formatDecimal(BigInt.asIntN(256, word)) }
    case "addr":
      if (word >> 160n !== 0n) return invalid("an addr word must be zero-padded to 20 bytes")
      return { value: `0x${hex.slice(-40)}` }
    case "bytes32":
    case "key":
      return { value: hex }
  }
}

type AbiAttribute = { name: Hex; typeId: number; value: Hex }

/**
 * Decodes one attribute triple. Never throws: a triple the node would refuse comes back with an
 * `error`, so the rest of the transaction still reads. A `bytes` value is reduced to its size and
 * keccak256 here, and its content goes no further.
 */
function decodeAttribute(cell: AbiAttribute, inPatch: boolean): DecodedAttribute {
  const { name, error: nameError } = decodeName(cell.name)
  const typeId = cell.typeId
  const indexed = (typeId & INDEXED_FLAG) !== 0
  const size = byteLength(cell.value)
  const base = typeId & ~INDEXED_FLAG
  const type = ATTRIBUTE_TYPES[base]

  let attribute: DecodedAttribute
  if (typeId === AttributeTypeId.Tombstone) {
    attribute = { name, typeId, type: "tombstone", indexed, value: null, size }
    if (!inPatch) attribute.error = "a tombstone (typeId 0) is legal only in a patch"
    else if (size !== 0) attribute.error = `a tombstone carries no value, got ${size} bytes`
  } else if (type === undefined) {
    attribute = {
      name,
      typeId,
      type: `invalid(${hexByte(typeId)})`,
      indexed,
      value: null,
      size,
      error:
        base === AttributeTypeId.Tombstone
          ? "a tombstone never carries the indexed flag"
          : `unknown attribute type ${hexByte(base)}`,
    }
  } else if (type === "bytes") {
    if (indexed) {
      attribute = {
        name,
        typeId,
        type: `invalid(${hexByte(typeId)})`,
        indexed,
        value: null,
        size,
        error: "bytes are stored, never indexed: the indexed flag is not allowed on bytes",
      }
    } else {
      attribute = { name, typeId, type, indexed, value: null, size, keccak256: keccak256(cell.value) }
      if (size > MAX_BYTES_LENGTH) {
        attribute.error = `a bytes value is at most ${MAX_BYTES_LENGTH} bytes, got ${size}`
      }
    }
  } else {
    const decoded = decodeValue(type, cell.value)
    attribute = { name, typeId, type, indexed, value: decoded.value, size }
    if (decoded.error !== undefined) attribute.error = decoded.error
  }

  // A malformed name outranks whatever else is wrong: the cell cannot even be named.
  if (nameError !== undefined) attribute.error = nameError
  return attribute
}

function decodeAttributes(cells: readonly AbiAttribute[], inPatch: boolean) {
  const attributes = cells.map((cell) => decodeAttribute(cell, inPatch))
  const bytesSize = attributes.reduce((total, a) => (a.type === "bytes" ? total + a.size : total), 0)
  return { attributes, bytesSize }
}

function expiryFields(expiresAt: bigint, minLifetime: bigint) {
  return {
    expiresAt: expiresAt.toString(),
    minLifetime: minLifetime.toString(),
    permanent: expiresAt === PERMANENT_EXPIRES_AT,
  }
}

/** Decode one entry of the tagged union: the tag says which struct `operationData` holds. */
function decodeOperation(op: { operation: number; operationData: Hex }): DecodedOperation {
  const operationType = op.operation
  const operation = OPERATION_NAMES[operationType] ?? `unknown(${operationType})`
  const base: DecodedOperation = {
    operationType,
    operation,
    entityKey: null,
    salt: null,
    creationFlags: null,
    expiresAt: null,
    minLifetime: null,
    permanent: null,
    newOwner: null,
    bytesSize: 0,
    attributes: [],
  }

  try {
    switch (operationType) {
      case OperationType.Create: {
        const [create] = decodeAbiParameters(CREATE_PARAMS, op.operationData)
        return {
          ...base,
          salt: create.salt.toString(),
          creationFlags: create.creationFlags,
          ...expiryFields(create.expiresAt, create.minLifetime),
          ...decodeAttributes(create.attributes, false),
        }
      }
      case OperationType.Patch: {
        const [patch] = decodeAbiParameters(PATCH_PARAMS, op.operationData)
        return {
          ...base,
          entityKey: patch.entityKey.toLowerCase() as Hex,
          ...decodeAttributes(patch.mutations, true),
        }
      }
      case OperationType.Extend: {
        const [extend] = decodeAbiParameters(EXTEND_PARAMS, op.operationData)
        return {
          ...base,
          entityKey: extend.entityKey.toLowerCase() as Hex,
          ...expiryFields(extend.expiresAt, extend.minLifetime),
        }
      }
      case OperationType.Transfer: {
        const [transfer] = decodeAbiParameters(TRANSFER_PARAMS, op.operationData)
        return {
          ...base,
          entityKey: transfer.entityKey.toLowerCase() as Hex,
          newOwner: transfer.newOwner.toLowerCase() as Address,
        }
      }
      case OperationType.Delete: {
        const [remove] = decodeAbiParameters(DELETE_PARAMS, op.operationData)
        return { ...base, entityKey: remove.entityKey.toLowerCase() as Hex }
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

function selectorOf(data: Hex): string {
  return data.slice(0, 10).toLowerCase()
}

/** Decode `execute(...)` calldata. */
export function decodeCalldata(data: Hex): DecodedTransaction {
  const selector = selectorOf(data)
  if (selector !== EXECUTE_SELECTOR) {
    throw new DecodeError(`Data is not an Arkiv execute() call: selector ${selector} is not ${EXECUTE_SELECTOR}`)
  }
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
    format: "udc",
    operations: args[0].map(decodeOperation),
  }
}

function isHexString(input: string): input is Hex {
  return /^0x[0-9a-fA-F]*$/.test(input)
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

  if (selectorOf(trimmed) === EXECUTE_SELECTOR) {
    return decodeCalldata(trimmed)
  }

  // Not raw calldata — try interpreting it as a serialized transaction.
  let tx
  try {
    tx = parseTransaction(trimmed)
  } catch {
    throw new DecodeError(
      `Data is neither Arkiv execute() calldata (selector ${EXECUTE_SELECTOR}, got ${selectorOf(trimmed)}) ` +
        "nor a parseable serialized transaction",
    )
  }

  if (!tx.data || selectorOf(tx.data) !== EXECUTE_SELECTOR) {
    throw new DecodeError(`Serialized transaction does not call Arkiv execute() (selector ${EXECUTE_SELECTOR})`)
  }

  const decoded = decodeCalldata(tx.data)
  const to = tx.to ? (tx.to.toLowerCase() as Address) : null
  decoded.to = to
  if (to && to !== ARKIV_ADDRESS) {
    decoded.warning = `Transaction target ${to} is not the known Arkiv registry ${ARKIV_ADDRESS}`
  }
  return decoded
}
