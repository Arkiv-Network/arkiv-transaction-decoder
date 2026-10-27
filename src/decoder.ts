import {
  type Address,
  type Hex,
  bytesToBigInt,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseTransaction,
  toFunctionSelector,
  toHex,
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

// The node's limits (crates/arkiv-node/src/signed/protocol.rs, src/arkiv/schema.rs).

/** The largest calldata, and the largest serialized transaction, the node accepts (its `TX_CAP`). */
export const MAX_INPUT_BYTES = 384 * 1024
/** The most operations one execute() call may carry. */
export const MAX_OPERATIONS = 128
/** The most attribute triples one create or patch may carry. */
export const MAX_ATTRIBUTES = 32
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

// The `operationData` struct each tag selects, spelled as the SDK spells it. Used to re-encode
// what was decoded, so only the canonical encoding is accepted.
const ATTRIBUTE_TUPLE = "(bytes32 name, uint8 typeId, bytes value)[]"

const CREATE_PARAMS = parseAbiParameters(
  `(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, ${ATTRIBUTE_TUPLE} attributes)`,
)
const PATCH_PARAMS = parseAbiParameters(`(bytes32 entityKey, ${ATTRIBUTE_TUPLE} mutations)`)
const EXTEND_PARAMS = parseAbiParameters("(bytes32 entityKey, uint64 expiresAt, uint64 minLifetime)")
const TRANSFER_PARAMS = parseAbiParameters("(bytes32 entityKey, address newOwner)")
const DELETE_PARAMS = parseAbiParameters("(bytes32 entityKey)")

/**
 * The input is not an Arkiv execute() call the node would accept. Its message is fixed text: it
 * never quotes the input or a library's own error.
 */
export class DecodeError extends Error {}

/**
 * An attribute value in the encoding the node's `arkiv_query` returns for it, so the two compare
 * with plain equality: `bool` a JSON boolean, `i32` a JSON number, `u64`/`u256` a `0x` quantity,
 * `dec` its trimmed decimal literal, `str` its text, and `bytes32`/`key`/`addr` lowercase `0x`
 * hex. `null` for `bytes` (never returned), a tombstone, and a value that does not decode.
 */
export type AttributeValue = string | number | boolean | null

export type DecodedAttribute = {
  name: string
  /** the raw `typeId` byte, indexed flag included */
  typeId: number
  /** the type in the low seven bits; "tombstone" for typeId 0; "invalid(0x..)" for a typeId the node refuses */
  type: AttributeType | "tombstone" | `invalid(0x${string})`
  /** bit 7 of typeId */
  indexed: boolean
  value: AttributeValue
  /** length of the value bytes as calldata carries them: 32 for a word type, the UTF-8 length of a str */
  size: number
  /** `bytes` only: keccak256 of the content, which is never returned */
  keccak256?: Hex
  /** present only when the node would refuse this triple: why */
  error?: string
}

export type OperationName = "create" | "patch" | "extend" | "transfer" | "delete"

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
  /**
   * create, extend: true when expiresAt asks for permanence (2**64-1). Only true is definitive: a
   * minLifetime that reaches 2**64-1 from the landing block is permanent too, which takes the block
   * to know.
   */
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

// --- strict, canonical ABI reading ------------------------------------------------------------
//
// The node accepts an execute() call only in its canonical encoding: it decodes, re-encodes and
// requires the bytes to match, for the call and for every operation's struct. This reader walks
// exactly the layout that encoding fixes — each offset where the canonical encoding puts it, each
// uint as wide as its type, each bytes value zero-padded, nothing after the end — so aliased
// offsets, dirty words and trailing data are refused before anything is copied. A small input
// therefore cannot expand into a large decode.

function refuse(reason: string): never {
  throw new DecodeError(`Data is not an Arkiv execute() call the node accepts: ${reason}`)
}

function word(data: Uint8Array, at: number): Uint8Array {
  if (at + 32 > data.length) refuse("it ends inside a word")
  return data.subarray(at, at + 32)
}

/** A uint word of `bits` bits: the bytes above them must be zero. */
function uint(data: Uint8Array, at: number, bits: number): bigint {
  const w = word(data, at)
  for (let i = 0; i < 32 - bits / 8; i++) {
    if (w[i] !== 0) refuse(`a uint${bits} word has bits set above its width`)
  }
  return bytesToBigInt(w)
}

/** An offset or length word that must hold exactly `expected`. */
function expectWord(data: Uint8Array, at: number, expected: number) {
  if (uint(data, at, 256) !== BigInt(expected)) refuse("an offset is not where the canonical encoding puts it")
}

/** A dynamic `bytes` at `at`: its length word, then the content, zero-padded to a whole word. */
function dynamicBytes(data: Uint8Array, at: number): { content: Uint8Array; next: number } {
  const length = uint(data, at, 256)
  const start = at + 32
  if (length > BigInt(Math.max(0, data.length - start))) refuse("a bytes value runs past the end")
  const n = Number(length)
  const next = start + Math.ceil(n / 32) * 32
  if (next > data.length) refuse("a bytes value runs past the end")
  for (let i = start + n; i < next; i++) {
    if (data[i] !== 0) refuse("a bytes value is not zero-padded")
  }
  return { content: data.subarray(start, start + n), next }
}

function expectEnd(data: Uint8Array, end: number) {
  if (end !== data.length) refuse("data follows the end of the encoding")
}

type RawOperation = { tag: number; data: Uint8Array }

/** The `(uint8 operation, bytes operationData)[]` argument of execute(), after the selector. */
function readOperations(args: Uint8Array): RawOperation[] {
  expectWord(args, 0, 0x20)
  const count = uint(args, 0x20, 256)
  if (count === 0n) refuse("it carries no operations")
  if (count > BigInt(MAX_OPERATIONS)) refuse(`it carries more than ${MAX_OPERATIONS} operations`)
  const n = Number(count)
  // Element offsets count from the end of the length word.
  const area = 0x40
  let offset = 32 * n
  const operations: RawOperation[] = []
  for (let i = 0; i < n; i++) {
    expectWord(args, area + 32 * i, offset)
    const at = area + offset
    const tag = Number(uint(args, at, 8))
    expectWord(args, at + 32, 0x40)
    const { content, next } = dynamicBytes(args, at + 64)
    operations.push({ tag, data: content })
    offset = next - area
  }
  expectEnd(args, area + offset)
  return operations
}

type RawAttribute = { name: Uint8Array; typeId: number; value: Uint8Array }

/** A `(bytes32 name, uint8 typeId, bytes value)[]` at `at`, with where it ends. */
function readAttributes(data: Uint8Array, at: number): { cells: RawAttribute[]; end: number } {
  const count = uint(data, at, 256)
  if (count > BigInt(MAX_ATTRIBUTES)) refuse(`an operation carries more than ${MAX_ATTRIBUTES} attributes`)
  const n = Number(count)
  const area = at + 32
  let offset = 32 * n
  const cells: RawAttribute[] = []
  for (let i = 0; i < n; i++) {
    expectWord(data, area + 32 * i, offset)
    const p = area + offset
    const name = word(data, p)
    const typeId = Number(uint(data, p + 32, 8))
    expectWord(data, p + 64, 0x60)
    const { content, next } = dynamicBytes(data, p + 96)
    cells.push({ name, typeId, value: content })
    offset = next - area
  }
  return { cells, end: area + offset }
}

/** Re-encodes what was read and requires the very bytes it came from, as the node does. */
function expectCanonical(original: Uint8Array, reencoded: Hex) {
  if (reencoded !== toHex(original)) refuse("it is not canonically encoded")
}

function abiCells(cells: RawAttribute[]) {
  return cells.map((c) => ({ name: toHex(c.name), typeId: c.typeId, value: toHex(c.value) }))
}

// --- attribute values ----------------------------------------------------------------------------

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    // ignoreBOM keeps a leading byte order mark as text, as the node does.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function hexByte(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(2, "0")}`
}

/** An Ident32 name: left-aligned, NUL-padded UTF-8. */
function decodeName(name: Uint8Array): { name: string; error?: string } {
  let end = name.indexOf(0)
  if (end === -1) end = name.length
  const text = name.subarray(end).every((b) => b === 0) ? decodeUtf8(name.subarray(0, end)) : undefined
  if (text === undefined) return { name: toHex(name), error: "the name is not NUL-padded UTF-8" }
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
function decodeValue(type: Exclude<AttributeType, "bytes">, value: Uint8Array): ValueResult {
  if (type === "str") {
    if (value.length > MAX_STR_BYTES) return invalid(`a str value is longer than ${MAX_STR_BYTES} bytes`)
    const text = decodeUtf8(value)
    if (text === undefined) return invalid("a str value must be valid UTF-8")
    if (CONTROL_CHARACTER.test(text)) return invalid("a str value must not contain control characters")
    return { value: text }
  }

  if (value.length !== 32) return invalid(`a ${type} value must be 32 bytes`)
  const hex = toHex(value)
  const w = bytesToBigInt(value)
  switch (type) {
    case "bool":
      if (w > 1n) return invalid("a bool word must hold exactly 0 or 1")
      return { value: w === 1n }
    case "i32": {
      const narrowed = BigInt.asIntN(32, w)
      if (BigInt.asUintN(256, narrowed) !== w) return invalid("an i32 word must be sign-extended")
      return { value: Number(narrowed) }
    }
    case "u64":
      if (w >> 64n !== 0n) return invalid("a u64 word must be zero-padded to 8 bytes")
      return { value: `0x${w.toString(16)}` }
    case "u256":
      return { value: `0x${w.toString(16)}` }
    case "dec":
      return { value: formatDecimal(BigInt.asIntN(256, w)) }
    case "addr":
      if (w >> 160n !== 0n) return invalid("an addr word must be zero-padded to 20 bytes")
      return { value: `0x${hex.slice(-40)}` }
    case "bytes32":
    case "key":
      return { value: hex }
  }
}

/**
 * Decodes one attribute triple. Never throws: a triple the node would refuse comes back with an
 * `error`, so the rest of the transaction still reads. A `bytes` value is reduced to its size and keccak256 here, and its content goes no further.
 */
function decodeAttribute(cell: RawAttribute, inPatch: boolean): DecodedAttribute {
  const { name, error: nameError } = decodeName(cell.name)
  const typeId = cell.typeId
  const indexed = (typeId & INDEXED_FLAG) !== 0
  const size = cell.value.length
  const base = typeId & ~INDEXED_FLAG
  const type = ATTRIBUTE_TYPES[base]

  let attribute: DecodedAttribute
  let valueError: string | undefined
  if (typeId === AttributeTypeId.Tombstone) {
    attribute = { name, typeId, type: "tombstone", indexed, value: null, size }
    if (!inPatch) valueError = "a tombstone (typeId 0) is legal only in a patch"
    else if (size !== 0) valueError = "a tombstone carries no value"
  } else if (type === undefined || (type === "bytes" && indexed)) {
    attribute = { name, typeId, type: `invalid(${hexByte(typeId)})`, indexed, value: null, size }
    if (type === "bytes") valueError = "bytes are stored, never indexed: the indexed flag is not allowed on bytes"
    else if (base === AttributeTypeId.Tombstone) valueError = "a tombstone never carries the indexed flag"
    else valueError = "the typeId names no attribute type"
  } else if (type === "bytes") {
    attribute = { name, typeId, type, indexed, value: null, size, keccak256: keccak256(cell.value) }
    if (size > MAX_BYTES_LENGTH) valueError = `a bytes value is longer than ${MAX_BYTES_LENGTH} bytes`
  } else {
    const decoded = decodeValue(type, cell.value)
    attribute = { name, typeId, type, indexed, value: decoded.value, size }
    valueError = decoded.error
  }

  // A malformed name outranks whatever else is wrong: the cell cannot even be named.
  const error = nameError ?? valueError
  if (error !== undefined) attribute.error = error
  return attribute
}

function decodeAttributes(cells: RawAttribute[], inPatch: boolean) {
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

// --- operations ----------------------------------------------------------------------------------

/** Decode one entry of the tagged union: the tag says which struct `operationData` holds. */
function decodeOperation({ tag, data }: RawOperation): DecodedOperation {
  const operation = OPERATION_NAMES[tag]
  if (operation === undefined) refuse("an operation tag is not one of 1 to 5")
  const base: DecodedOperation = {
    operationType: tag,
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

  let decoded: DecodedOperation
  switch (tag) {
    case OperationType.Create: {
      // abi.encode of a dynamic struct: an offset to it, then its head and tail.
      expectWord(data, 0, 0x20)
      const salt = uint(data, 0x20, 128)
      const expiresAt = uint(data, 0x40, 64)
      const minLifetime = uint(data, 0x60, 64)
      const creationFlags = Number(uint(data, 0x80, 8))
      expectWord(data, 0xa0, 0xa0)
      const { cells, end } = readAttributes(data, 0xc0)
      expectEnd(data, end)
      expectCanonical(
        data,
        encodeAbiParameters(CREATE_PARAMS, [{ salt, expiresAt, minLifetime, creationFlags, attributes: abiCells(cells) }]),
      )
      decoded = {
        ...base,
        salt: salt.toString(),
        creationFlags,
        ...expiryFields(expiresAt, minLifetime),
        ...decodeAttributes(cells, false),
      }
      break
    }
    case OperationType.Patch: {
      expectWord(data, 0, 0x20)
      const entityKey = toHex(word(data, 0x20))
      expectWord(data, 0x40, 0x40)
      const { cells, end } = readAttributes(data, 0x60)
      expectEnd(data, end)
      expectCanonical(data, encodeAbiParameters(PATCH_PARAMS, [{ entityKey, mutations: abiCells(cells) }]))
      decoded = { ...base, entityKey, ...decodeAttributes(cells, true) }
      break
    }
    case OperationType.Extend: {
      // Static structs are encoded in place.
      const entityKey = toHex(word(data, 0))
      const expiresAt = uint(data, 0x20, 64)
      const minLifetime = uint(data, 0x40, 64)
      expectEnd(data, 0x60)
      expectCanonical(data, encodeAbiParameters(EXTEND_PARAMS, [{ entityKey, expiresAt, minLifetime }]))
      decoded = { ...base, entityKey, ...expiryFields(expiresAt, minLifetime) }
      break
    }
    case OperationType.Transfer: {
      const entityKey = toHex(word(data, 0))
      uint(data, 0x20, 160)
      const newOwner = `0x${toHex(word(data, 0x20)).slice(-40)}` as Address
      expectEnd(data, 0x40)
      expectCanonical(data, encodeAbiParameters(TRANSFER_PARAMS, [{ entityKey, newOwner }]))
      decoded = { ...base, entityKey, newOwner }
      break
    }
    default: {
      const entityKey = toHex(word(data, 0))
      expectEnd(data, 0x20)
      expectCanonical(data, encodeAbiParameters(DELETE_PARAMS, [{ entityKey }]))
      decoded = { ...base, entityKey }
    }
  }

  return decoded
}

function selectorOf(data: string): string {
  return data.slice(0, 10).toLowerCase()
}

/** Bounded first, then shaped: the node takes nothing larger than its cap. */
function checkHex(input: string): Hex {
  if (input.length > 2 + 2 * MAX_INPUT_BYTES) {
    throw new DecodeError(`Input is longer than the node's ${MAX_INPUT_BYTES}-byte transaction cap`)
  }
  if (!/^0x[0-9a-fA-F]*$/.test(input)) throw new DecodeError("Input must be a 0x-prefixed hex string")
  if (input.length % 2 !== 0) throw new DecodeError("Input must be a whole number of bytes: an even count of hex digits")
  return input as Hex
}

/** Decode `execute(...)` calldata. */
export function decodeCalldata(input: Hex): DecodedTransaction {
  const data = checkHex(input)
  if (selectorOf(data) !== EXECUTE_SELECTOR) {
    throw new DecodeError(`Data is not an Arkiv execute() call: its selector is not ${EXECUTE_SELECTOR}`)
  }
  const calldata = hexToBytes(data)
  const raw = readOperations(calldata.subarray(4))
  expectCanonical(
    calldata,
    encodeFunctionData({
      abi: EXECUTE_ABI,
      functionName: "execute",
      args: [raw.map((op) => ({ operation: op.tag, operationData: toHex(op.data) }))],
    }),
  )
  return { functionName: "execute", format: "udc", operations: raw.map(decodeOperation) }
}

/**
 * Decode either bare `execute(...)` calldata or a full RLP-serialized transaction
 * (signed or unsigned) whose data is an Arkiv execute() call.
 */
export function decodeArkivTransaction(input: string): DecodedTransaction {
  const hex = checkHex(input.trim())

  if (selectorOf(hex) === EXECUTE_SELECTOR) return decodeCalldata(hex)

  // Not raw calldata: try interpreting it as a serialized transaction. Whatever the parser
  // objects to is a fault of the input, and its own message is not passed on.
  let tx
  try {
    tx = parseTransaction(hex)
  } catch {
    throw new DecodeError(
      `Data is neither Arkiv execute() calldata (selector ${EXECUTE_SELECTOR}) nor a parseable serialized transaction`,
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
