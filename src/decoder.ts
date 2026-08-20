import {
  type Address,
  type Hex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  parseTransaction,
  toFunctionSelector,
  toHex,
} from "viem"
import {
  ATTRIBUTE_TYPE_NAMES,
  type ArkivAttributeTypeName,
  ArkivAttributeType,
  type ArkivOperationName,
  ArkivOperationTag,
  type ArkivViewFunctionName,
  CONTENT_TYPE_ATTRIBUTE,
  CREATE_PARAMS,
  CREATION_FLAGS_MASK,
  CREATION_FLAG_PERMISSIONLESS_EXTENSION,
  CREATION_FLAG_READONLY,
  DECIMAL_SCALE,
  DELETE_PARAMS,
  EXECUTE_V2_ABI,
  EXECUTE_V2_SELECTOR,
  EXTEND_EXPIRY_PARAMS,
  MAX_ATTRIBUTES,
  MAX_PAYLOAD_BYTES,
  MAX_STR_BYTES,
  OPERATION_NAMES_V2,
  PATCH_PARAMS,
  PAYLOAD_ATTRIBUTE,
  TRANSFER_OWNERSHIP_PARAMS,
  U64_MAX,
  VIEW_FUNCTION_NAMES,
  WORD_LEN,
} from "./abi"

// ---------------------------------------------------------------------------
// Legacy ABI (generation 1). Kept verbatim: existing callers still send it.
// ---------------------------------------------------------------------------

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

export const LEGACY_EXECUTE_SELECTOR = toFunctionSelector(ENTITY_EXECUTE_ABI[0])
/** @deprecated kept for callers written against the single-ABI decoder */
export const EXECUTE_SELECTOR = LEGACY_EXECUTE_SELECTOR

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

// ---------------------------------------------------------------------------
// Errors. Every one extends DecodeError so callers that already catch it keep
// working; the server checks the specific classes first to pick a status code.
// ---------------------------------------------------------------------------

/** Genuine "this is not an Arkiv call". The only condition the server answers with 400. */
export class DecodeError extends Error {
  readonly code: string = "NOT_ARKIV_CALLDATA"
}

/**
 * The 4-byte selector is not one we decode. Always names the selector, so the caller can
 * see which one, but only claims to be a decoder gap when the call is known to have
 * reached the registry.
 *
 * The target is the only signal that separates the two. Shape is not: every well-formed
 * EVM call is word-aligned, so a plain ERC20 transfer looks exactly like a registry call
 * with a selector we are missing. Reading UNKNOWN_SELECTOR onto both would put every token
 * transfer on the chain in the decoder-gap bucket and leave anyone counting
 * NOT_ARKIV_CALLDATA to size foreign traffic counting the wrong thing.
 */
export class UnknownSelectorError extends DecodeError {
  override readonly code: string
  constructor(
    readonly selector: Hex,
    readonly targetIsRegistry: boolean,
    message: string,
  ) {
    super(message)
    this.code = targetIsRegistry ? "UNKNOWN_SELECTOR" : "NOT_ARKIV_CALLDATA"
  }
}

class ValueDecodeError extends Error {}

/**
 * Calldata this decoder recognises as registry traffic but cannot fully decode.
 *
 * A gap is data, not an exception. The bytes reach us from a public chain, and a reverted
 * transaction still sits in the block, so anyone can send calldata that no decoder can
 * parse. Reporting that as a failing status hands a stranger the power to stop the caller:
 * arkiv-chain-indexer maps 400 to "skip", throws on every other status, and retries the
 * same block forever. So the gap travels in the body at 200, the caller records a row, and
 * the operator reads the log and the counter.
 */
export const DECODER_GAP_CODES = {
  UNKNOWN_SELECTOR: "UNKNOWN_SELECTOR",
  MALFORMED_CALLDATA: "MALFORMED_CALLDATA",
  MALFORMED_OPERATION_DATA: "MALFORMED_OPERATION_DATA",
  UNKNOWN_OPERATION_TAG: "UNKNOWN_OPERATION_TAG",
} as const

export type DecoderGapCode = keyof typeof DECODER_GAP_CODES

/** The machine-readable marker a caller stores instead of stopping. */
export type DecoderGap = {
  code: DecoderGapCode
  message: string
}

export type DecoderGapTally = { code: DecoderGapCode; subject: string; count: number }

const tallies = new Map<string, DecoderGapTally>()

/**
 * The operator-facing half of a gap: a log line and a counter. Status codes cannot carry
 * this, because the caller that would see the status is the one we must not stop.
 *
 * Only the first occurrence of each (code, subject) logs. A chain carries a lot of ordinary
 * foreign traffic, and a line per transaction buries the one new selector that matters.
 */
export function recordGap(gap: DecoderGap, subject = ""): DecoderGap {
  const key = subject === "" ? gap.code : `${gap.code} ${subject}`
  const tally = tallies.get(key)
  if (tally === undefined) {
    tallies.set(key, { code: gap.code, subject, count: 1 })
    console.warn(`[decoder-gap] ${key}: ${gap.message}`)
  } else {
    tally.count += 1
  }
  return gap
}

/** Every gap seen since start, most frequent first. Served by GET /api/selectors. */
export function decoderGaps(): DecoderGapTally[] {
  return [...tallies.values()].sort((a, b) => b.count - a.count)
}

export function resetDecoderGaps(): void {
  tallies.clear()
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function trimTrailingZeros(bytes: Uint8Array): Uint8Array {
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  return bytes.slice(0, end)
}

// Ident32: string left-aligned in a single bytes32, null-padded on the right.
export function decodeIdent32(name: Hex): string {
  const bytes = trimTrailingZeros(hexToBytes(name))
  return decodeUtf8(bytes) ?? name
}

function isHexString(input: string): input is Hex {
  return /^0x[0-9a-fA-F]*$/.test(input)
}

// ---------------------------------------------------------------------------
// Legacy decoding
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Generation-2 decoding
// ---------------------------------------------------------------------------

export type DecodedAttributeV2 = {
  key: string
  valueType: number
  valueTypeName: ArkivAttributeTypeName | "unknown" | "invalid"
  value: string
  /** wire byte length of the value before rendering */
  sizeBytes: number
  /** set when the value was too large to render and `value` is empty */
  truncated?: true
  /** set when valueTypeName is "invalid" */
  error?: string
}

export type DecodedPayload = {
  /** REQUIRED by arkiv-chain-indexer. Wire byte length of the $payload attribute, 0 when absent. */
  size: number
  /** whether the operation carried a $payload attribute at all */
  present: boolean
  hex?: Hex
  text?: string
  /** set when hex was omitted because the payload exceeds payloadHexLimit */
  truncated?: true
}

/** Mirrors the legacy path's `unknown(N)`: a tag we read but cannot act on. */
export type UnknownOperationName = `unknown(${number})`

export type DecodedOperationV2 = {
  index: number
  operationType: number
  operation: ArkivOperationName | UnknownOperationName
  /** set when this one operation could not be decoded; the batch around it still decodes */
  undecodable?: DecoderGap
  /** null for a create: the key is derived on chain from the owner nonce, so bare calldata cannot report it */
  entityKey: Hex | null
  /** create only, decimal string (uint128 overflows a JS number) */
  salt: string | null
  creationFlags: number | null
  creationFlagNames: string[] | null
  contentType: string | null
  payload: DecodedPayload
  /** user attributes only: $payload and $contentType are lifted into their own fields */
  attributes: DecodedAttributeV2[]
  /** names of the system attributes lifted out, so nothing is dropped silently */
  systemAttributes: string[]
  /** raw attribute count from the calldata, including the lifted system ones */
  attributeCount: number
  /** raw uint64 from the calldata, decimal string. 0 means a purely relative lifetime. */
  expiresAt: string | null
  minLifetime: string | null
  /** max(expiresAt, blockNumber + minLifetime); only set when the caller supplied blockNumber */
  resolvedExpiresAt: string | null
  /**
   * Compatibility field for arkiv-chain-indexer: the resolved block when known, else the
   * raw expiresAt. A decimal string, like the three fields above it.
   *
   * It was a JS number, which cannot hold a uint64. arkiv-reth-executor expresses
   * permanence as expiresAt = u64::MAX (decode.rs:167), an ordinary successful value, and
   * Number() turns it into 18446744073709552000: wrong by 385 and past the int8 ceiling of
   * the indexer's expires_at_blocks column, so the INSERT fails and the block retries
   * forever. The first permanent entity on the network would stop indexing.
   *
   * A consumer that reads this as a number now sees a string and falls back, which loses a
   * value rather than a chain. resolvedExpiresAt carries the same number exactly.
   */
  expiresAtBlocks: string
  newOwner: Address | null
}

export type DecodedTransactionV2 = {
  functionName: "execute"
  abi: "v2"
  selector: Hex
  /** set when the argument block itself did not decode, so there are no operations to report */
  undecodable?: DecoderGap
  to?: Address | null
  /** set when `to` is present and differs from the known Arkiv registry address */
  warning?: string
  /** non-fatal notes: unknown attribute types, non-canonical encodings, oversize values */
  warnings?: string[]
  operationCount: number
  operations: DecodedOperationV2[]
}

/** A registry read-only call. Recognised, carries no operations. */
export type DecodedViewCall = {
  functionName: ArkivViewFunctionName
  abi: "v2"
  selector: Hex
  to?: Address | null
  warning?: string
  warnings?: string[]
  operationCount: 0
  operations: []
}

export type DecodeResult = DecodedTransaction | DecodedTransactionV2 | DecodedViewCall

export type DecodeOptions = {
  /** Target of the call when the caller knows it. Lets an unknown selector be reported loudly. */
  to?: Address | null
  /** Block the transaction executed in. Required to resolve a relative expiry. */
  blockNumber?: bigint | null
  /** Include payload.hex only when the payload is at most this many bytes. Default 8192. */
  payloadHexLimit?: number
}

export const DEFAULT_PAYLOAD_HEX_LIMIT = 8192

const OPERATION_NAME_BY_TAG: Record<number, ArkivOperationName | undefined> = OPERATION_NAMES_V2
const ATTRIBUTE_TYPE_NAME_BY_ID: Record<number, ArkivAttributeTypeName | undefined> = ATTRIBUTE_TYPE_NAMES
const VIEW_FUNCTION_BY_SELECTOR: Record<string, ArkivViewFunctionName | undefined> = VIEW_FUNCTION_NAMES

/**
 * max(expiresAt, blockNumber + minLifetime), the rule the executor applies on chain,
 * saturated at u64::MAX.
 *
 * The executor uses checked_add and reverts with ExpiryOverflow
 * (arkiv-reth-executor/src/decode.rs:168), so a sum past u64::MAX is a block number the
 * chain never records. Reporting the unsaturated sum would report a block that cannot
 * exist: minLifetime = u64::MAX at block 222498 gives 18446744073709774113.
 */
export function resolveExpiry(expiresAt: bigint, minLifetime: bigint, blockNumber: bigint): bigint {
  const relative = blockNumber + minLifetime
  const resolved = expiresAt > relative ? expiresAt : relative
  return resolved > U64_MAX ? U64_MAX : resolved
}

export function creationFlagNames(flags: number): string[] {
  const names: string[] = []
  if (flags & CREATION_FLAG_READONLY) names.push("readonly")
  if (flags & CREATION_FLAG_PERMISSIONLESS_EXTENSION) names.push("permissionlessExtension")
  return names
}

function requireWord(bytes: Uint8Array, typeName: string): void {
  if (bytes.length !== WORD_LEN) {
    throw new ValueDecodeError(`${typeName} value must be exactly ${WORD_LEN} bytes, got ${bytes.length}`)
  }
}

// The chain rejects non-canonical padding, so accepting it here would report something
// the chain would have refused.
function requireZeroPrefix(bytes: Uint8Array, prefixLength: number, typeName: string): void {
  for (let i = 0; i < prefixLength; i++) {
    if (bytes[i] !== 0) throw new ValueDecodeError(`${typeName} value has non-zero padding at byte ${i}`)
  }
}

function toUnsigned(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

function formatDecimal(value: bigint, scale: bigint): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const unit = 10n ** scale
  const whole = abs / unit
  const fraction = abs % unit
  const sign = negative ? "-" : ""
  if (fraction === 0n) return `${sign}${whole}`
  const digits = fraction.toString().padStart(Number(scale), "0").replace(/0+$/, "")
  return `${sign}${whole}.${digits}`
}

function renderValue(typeId: number, bytes: Uint8Array, raw: Hex, hexLimit: number): { value: string; truncated?: true } {
  const typeName = ATTRIBUTE_TYPE_NAME_BY_ID[typeId] ?? String(typeId)
  switch (typeId) {
    case ArkivAttributeType.Tombstone:
      if (bytes.length !== 0) throw new ValueDecodeError("tombstone value must be empty")
      return { value: "" }
    case ArkivAttributeType.Bool: {
      requireWord(bytes, typeName)
      requireZeroPrefix(bytes, WORD_LEN - 1, typeName)
      const last = bytes[WORD_LEN - 1]
      if (last !== 0 && last !== 1) throw new ValueDecodeError("bool value must be 0 or 1")
      return { value: last === 1 ? "true" : "false" }
    }
    case ArkivAttributeType.Int: {
      requireWord(bytes, typeName)
      // low 4 bytes are the i32; JS `<<` is 32-bit signed so this yields the signed value
      const low = ((bytes[28] as number) << 24) | ((bytes[29] as number) << 16) | ((bytes[30] as number) << 8) | (bytes[31] as number)
      const fill = low < 0 ? 0xff : 0x00
      for (let i = 0; i < 28; i++) {
        if (bytes[i] !== fill) throw new ValueDecodeError("i32 value has non-canonical sign extension")
      }
      return { value: String(low) }
    }
    case ArkivAttributeType.Uint64:
      requireWord(bytes, typeName)
      requireZeroPrefix(bytes, WORD_LEN - 8, typeName)
      return { value: toUnsigned(bytes).toString() }
    case ArkivAttributeType.Uint256:
      requireWord(bytes, typeName)
      return { value: toUnsigned(bytes).toString() }
    case ArkivAttributeType.Decimal: {
      requireWord(bytes, typeName)
      const unsigned = toUnsigned(bytes)
      const signed = unsigned >= 1n << 255n ? unsigned - (1n << 256n) : unsigned
      return { value: formatDecimal(signed, DECIMAL_SCALE) }
    }
    case ArkivAttributeType.Bytes32:
    case ArkivAttributeType.EntityKey:
      requireWord(bytes, typeName)
      return { value: raw }
    case ArkivAttributeType.Bytes:
      if (bytes.length > hexLimit) return { value: "", truncated: true }
      return { value: raw }
    case ArkivAttributeType.Str: {
      const text = decodeUtf8(bytes)
      if (text === undefined) throw new ValueDecodeError("str value is not valid UTF-8")
      return { value: text }
    }
    case ArkivAttributeType.Address: {
      requireWord(bytes, typeName)
      requireZeroPrefix(bytes, WORD_LEN - 20, typeName)
      return { value: getAddress(`0x${raw.slice(26)}`) }
    }
    default:
      throw new ValueDecodeError(`unhandled attribute type ${typeId}`)
  }
}

export function decodeAttributeV2(
  attr: { name: Hex; typeId: number; value: Hex },
  hexLimit: number = DEFAULT_PAYLOAD_HEX_LIMIT,
): DecodedAttributeV2 {
  const key = decodeIdent32(attr.name)
  const bytes = hexToBytes(attr.value)
  const base = { key, valueType: attr.typeId, sizeBytes: bytes.length }

  // An unfamiliar typeId is recorded, never fatal: the type set is an open enum the
  // protocol may extend, and halting an indexer on one unknown value is worse.
  if (ATTRIBUTE_TYPE_NAME_BY_ID[attr.typeId] === undefined) {
    return { ...base, valueTypeName: "unknown", value: attr.value }
  }

  try {
    const { value, truncated } = renderValue(attr.typeId, bytes, attr.value, hexLimit)
    return {
      ...base,
      valueTypeName: ATTRIBUTE_TYPE_NAME_BY_ID[attr.typeId] as ArkivAttributeTypeName,
      value,
      ...(truncated ? { truncated } : {}),
    }
  } catch (e) {
    return {
      ...base,
      valueTypeName: "invalid",
      value: attr.value,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

type RawAttribute = { name: Hex; typeId: number; value: Hex }

type OperationParams =
  | typeof CREATE_PARAMS
  | typeof PATCH_PARAMS
  | typeof EXTEND_EXPIRY_PARAMS
  | typeof TRANSFER_OWNERSHIP_PARAMS
  | typeof DELETE_PARAMS

const OPERATION_PARAMS: Record<number, OperationParams | undefined> = {
  [ArkivOperationTag.Create]: CREATE_PARAMS,
  [ArkivOperationTag.Patch]: PATCH_PARAMS,
  [ArkivOperationTag.ExtendExpiry]: EXTEND_EXPIRY_PARAMS,
  [ArkivOperationTag.TransferOwnership]: TRANSFER_OWNERSHIP_PARAMS,
  [ArkivOperationTag.Delete]: DELETE_PARAMS,
}

function emptyPayload(): DecodedPayload {
  return { size: 0, present: false }
}

function shapePayload(attr: RawAttribute | undefined, hexLimit: number, warnings: string[]): DecodedPayload {
  if (!attr) return emptyPayload()
  const bytes = hexToBytes(attr.value)
  if (attr.typeId === ArkivAttributeType.Tombstone) {
    warnings.push(`${PAYLOAD_ATTRIBUTE} is a tombstone: the operation removes the payload`)
    return { size: 0, present: true }
  }
  if (attr.typeId !== ArkivAttributeType.Bytes) {
    warnings.push(`${PAYLOAD_ATTRIBUTE} has unexpected type ${attr.typeId}, expected ${ArkivAttributeType.Bytes} (bytes)`)
  }
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    warnings.push(`${PAYLOAD_ATTRIBUTE} is ${bytes.length} bytes, above the ${MAX_PAYLOAD_BYTES} byte protocol limit`)
  }
  if (bytes.length > hexLimit) {
    return { size: bytes.length, present: true, truncated: true }
  }
  const text = bytes.length > 0 ? decodeUtf8(bytes) : undefined
  return {
    size: bytes.length,
    present: true,
    hex: attr.value,
    ...(text !== undefined ? { text } : {}),
  }
}

function shapeContentType(attr: RawAttribute | undefined, warnings: string[]): string | null {
  if (!attr) return null
  if (attr.typeId === ArkivAttributeType.Tombstone) {
    warnings.push(`${CONTENT_TYPE_ATTRIBUTE} is a tombstone: the operation removes the content type`)
    return null
  }
  const text = decodeUtf8(hexToBytes(attr.value))
  if (text === undefined) {
    warnings.push(`${CONTENT_TYPE_ATTRIBUTE} is not valid UTF-8`)
    return null
  }
  return text
}

// Mirrors the node's NonCanonicalOperationData check: re-encoding a canonical struct
// must reproduce the original bytes.
function checkCanonical(params: OperationParams, decoded: unknown, original: Hex, index: number, warnings: string[]): void {
  let reencoded: Hex
  try {
    reencoded = encodeAbiParameters(params, [decoded] as never)
  } catch {
    warnings.push(`operation ${index}: could not re-encode to verify canonical form`)
    return
  }
  if (reencoded.toLowerCase() !== original.toLowerCase()) {
    warnings.push(`operation ${index}: operationData is not canonically encoded`)
  }
}

/**
 * Rules the executor enforces that this decoder can still parse past. Warnings, never
 * failures: the transaction sits in the block either way and the caller has to record it.
 * Saying nothing would describe an entity the chain refused as though it existed.
 */
function checkAttributeRules(raw: readonly RawAttribute[], index: number, warnings: string[]): void {
  if (raw.length > MAX_ATTRIBUTES) {
    warnings.push(`operation ${index}: ${raw.length} attributes, above the ${MAX_ATTRIBUTES} attribute protocol limit`)
  }
  let previous: RawAttribute | undefined
  for (const attr of raw) {
    if (attr.typeId === ArkivAttributeType.Str) {
      const size = hexToBytes(attr.value).length
      if (size > MAX_STR_BYTES) {
        warnings.push(
          `operation ${index}: str attribute ${decodeIdent32(attr.name)} is ${size} bytes, above the ${MAX_STR_BYTES} byte protocol limit`,
        )
      }
    }
    if (previous !== undefined) {
      // Ident32 is left-aligned and null-padded, so reading the two words as big-endian
      // integers gives the byte order the chain sorts on.
      const order = BigInt(previous.name) - BigInt(attr.name)
      if (order === 0n) {
        warnings.push(
          `operation ${index}: attribute ${decodeIdent32(attr.name)} appears more than once, which the chain rejects`,
        )
      } else if (order > 0n) {
        warnings.push(
          `operation ${index}: attribute ${decodeIdent32(attr.name)} follows ${decodeIdent32(previous.name)}, so the chain rejects this with AttributesNotSorted`,
        )
      }
    }
    previous = attr
  }
}

function splitAttributes(
  raw: readonly RawAttribute[],
  index: number,
  warnings: string[],
): { user: RawAttribute[]; payload?: RawAttribute; contentType?: RawAttribute; systemNames: string[] } {
  const user: RawAttribute[] = []
  const systemNames: string[] = []
  let payload: RawAttribute | undefined
  let contentType: RawAttribute | undefined
  for (const attr of raw) {
    const key = decodeIdent32(attr.name)
    if (key === PAYLOAD_ATTRIBUTE) {
      // Last one wins, as it would in any map built from this list. Worth saying out loud:
      // payload.size is the number the metrics pipeline stores, so a silent overwrite
      // records the wrong size for the entity.
      if (payload !== undefined) {
        warnings.push(
          `operation ${index}: ${PAYLOAD_ATTRIBUTE} appears more than once; payload.size reports the last one`,
        )
      }
      payload = attr
      systemNames.push(key)
    } else if (key === CONTENT_TYPE_ATTRIBUTE) {
      if (contentType !== undefined) {
        warnings.push(
          `operation ${index}: ${CONTENT_TYPE_ATTRIBUTE} appears more than once; contentType reports the last one`,
        )
      }
      contentType = attr
      systemNames.push(key)
    } else {
      user.push(attr)
    }
  }
  return { user, payload, contentType, systemNames }
}

function expiryFields(
  expiresAt: bigint,
  minLifetime: bigint,
  blockNumber: bigint | null,
  index: number,
  warnings: string[],
): Pick<DecodedOperationV2, "expiresAt" | "minLifetime" | "resolvedExpiresAt" | "expiresAtBlocks"> {
  const resolved = blockNumber === null ? null : resolveExpiry(expiresAt, minLifetime, blockNumber)
  // Two expiries the executor refuses outright, so a decode that reports them without a
  // word describes an entity the chain never created.
  if (blockNumber !== null && resolved !== null) {
    if (blockNumber + minLifetime > U64_MAX) {
      warnings.push(
        `operation ${index}: block ${blockNumber} + minLifetime ${minLifetime} overflows u64, so the chain rejects this with ExpiryOverflow; the resolved expiry is saturated at ${U64_MAX}`,
      )
    } else if (resolved <= blockNumber) {
      warnings.push(
        `operation ${index}: resolved expiry ${resolved} is not after block ${blockNumber}, so the chain rejects this with ExpiryDeadOnArrival`,
      )
    }
  }
  return {
    expiresAt: expiresAt.toString(),
    minLifetime: minLifetime.toString(),
    resolvedExpiresAt: resolved === null ? null : resolved.toString(),
    expiresAtBlocks: (resolved ?? expiresAt).toString(),
  }
}

/**
 * Every field a caller needs, at its empty value. An operation the decoder cannot read is
 * still returned in this shape, so a batch of five with one bad tag reports five rows.
 */
function blankOperation(index: number, tag: number): DecodedOperationV2 {
  return {
    index,
    operationType: tag,
    operation: `unknown(${tag})`,
    entityKey: null,
    salt: null,
    creationFlags: null,
    creationFlagNames: null,
    contentType: null,
    payload: emptyPayload(),
    attributes: [],
    systemAttributes: [],
    attributeCount: 0,
    expiresAt: null,
    minLifetime: null,
    resolvedExpiresAt: null,
    expiresAtBlocks: "0",
    newOwner: null,
  }
}

/**
 * The operation keeps the raw tag and the legacy `unknown(N)` name, never the name the tag
 * claims: a struct we could not parse is not evidence that the operation it names happened,
 * and a metrics pipeline must not count it as one.
 */
function undecodableOperation(index: number, tag: number, code: DecoderGapCode, message: string): DecodedOperationV2 {
  return { ...blankOperation(index, tag), undecodable: recordGap({ code, message }) }
}

export function decodeOperationV2(
  op: { operation: number; operationData: Hex },
  index: number,
  options: { blockNumber: bigint | null; payloadHexLimit: number },
  warnings: string[],
): DecodedOperationV2 {
  const tag = op.operation
  const name = OPERATION_NAME_BY_TAG[tag]
  const params = OPERATION_PARAMS[tag]
  if (name === undefined || params === undefined) {
    return undecodableOperation(
      index,
      tag,
      "UNKNOWN_OPERATION_TAG",
      `Operation ${index} has tag ${tag}, which this decoder does not know (expected 1..5)`,
    )
  }

  let decoded: unknown
  try {
    ;[decoded] = decodeAbiParameters(params, op.operationData) as [unknown]
  } catch (e) {
    return undecodableOperation(
      index,
      tag,
      "MALFORMED_OPERATION_DATA",
      `Operation ${index} claims tag ${tag} (${name}) but its operationData does not match the ${name} struct: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
  checkCanonical(params, decoded, op.operationData, index, warnings)

  const common = { ...blankOperation(index, tag), operation: name }

  switch (tag) {
    case ArkivOperationTag.Create: {
      const create = decoded as {
        salt: bigint
        expiresAt: bigint
        minLifetime: bigint
        creationFlags: number
        attributes: readonly RawAttribute[]
      }
      const split = splitAttributes(create.attributes, index, warnings)
      if (create.creationFlags & ~CREATION_FLAGS_MASK) {
        warnings.push(`operation ${index}: creationFlags ${create.creationFlags} sets bits outside the known mask`)
      }
      checkAttributeRules(create.attributes, index, warnings)
      return {
        ...common,
        // Create carries a salt, not a key: the entity key is derived on chain from the
        // owner's nonce, which bare calldata does not contain.
        salt: create.salt.toString(),
        creationFlags: create.creationFlags,
        creationFlagNames: creationFlagNames(create.creationFlags),
        contentType: shapeContentType(split.contentType, warnings),
        payload: shapePayload(split.payload, options.payloadHexLimit, warnings),
        attributes: split.user.map((a) => decodeAttributeV2(a, options.payloadHexLimit)),
        systemAttributes: split.systemNames,
        attributeCount: create.attributes.length,
        ...expiryFields(create.expiresAt, create.minLifetime, options.blockNumber, index, warnings),
      }
    }
    case ArkivOperationTag.Patch: {
      const patch = decoded as { entityKey: Hex; mutations: readonly RawAttribute[] }
      const split = splitAttributes(patch.mutations, index, warnings)
      // A patch carries the same attribute rules as a create; only the create was checked.
      checkAttributeRules(patch.mutations, index, warnings)
      return {
        ...common,
        entityKey: patch.entityKey,
        contentType: shapeContentType(split.contentType, warnings),
        payload: shapePayload(split.payload, options.payloadHexLimit, warnings),
        attributes: split.user.map((a) => decodeAttributeV2(a, options.payloadHexLimit)),
        systemAttributes: split.systemNames,
        attributeCount: patch.mutations.length,
      }
    }
    case ArkivOperationTag.ExtendExpiry: {
      const extend = decoded as { entityKey: Hex; expiresAt: bigint; minLifetime: bigint }
      return {
        ...common,
        entityKey: extend.entityKey,
        ...expiryFields(extend.expiresAt, extend.minLifetime, options.blockNumber, index, warnings),
      }
    }
    case ArkivOperationTag.TransferOwnership: {
      const transfer = decoded as { entityKey: Hex; newOwner: Address }
      return { ...common, entityKey: transfer.entityKey, newOwner: getAddress(transfer.newOwner) }
    }
    default: {
      const remove = decoded as { entityKey: Hex }
      return { ...common, entityKey: remove.entityKey }
    }
  }
}

/** Decode generation-2 `execute((uint8,bytes)[])` calldata. */
export function decodeCalldataV2(data: Hex, options: DecodeOptions = {}): DecodedTransactionV2 {
  let args
  try {
    ;({ args } = decodeFunctionData({ abi: EXECUTE_V2_ABI, data }))
  } catch (e) {
    // The selector is ours, so this is registry traffic and the caller must record it.
    // There are no operations to report, which is exactly what an empty batch looks like.
    return {
      functionName: "execute",
      abi: "v2",
      selector: EXECUTE_V2_SELECTOR,
      undecodable: recordGap({
        code: "MALFORMED_CALLDATA",
        message: `Calldata carries the Arkiv execute() selector ${EXECUTE_V2_SELECTOR} but the argument block does not decode: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }),
      operationCount: 0,
      operations: [],
    }
  }

  const warnings: string[] = []
  const opOptions = {
    blockNumber: options.blockNumber ?? null,
    payloadHexLimit: options.payloadHexLimit ?? DEFAULT_PAYLOAD_HEX_LIMIT,
  }
  const operations = args[0].map((op, index) =>
    decodeOperationV2({ operation: op.operation, operationData: op.operationData }, index, opOptions, warnings),
  )

  return {
    functionName: "execute",
    abi: "v2",
    selector: EXECUTE_V2_SELECTOR,
    operationCount: operations.length,
    operations,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Selectors this service decodes, newest generation first. */
export const KNOWN_SELECTORS: Hex[] = [EXECUTE_V2_SELECTOR, LEGACY_EXECUTE_SELECTOR]

function selectorOf(data: Hex): Hex {
  return data.slice(0, 10).toLowerCase() as Hex
}

function decodeBySelector(data: Hex, options: DecodeOptions): DecodeResult | null {
  if (data.length < 10) return null
  const selector = selectorOf(data)

  if (selector === EXECUTE_V2_SELECTOR) return decodeCalldataV2(data, options)
  if (selector === LEGACY_EXECUTE_SELECTOR.toLowerCase()) {
    const decoded = decodeCalldata(data)
    decoded.abi = "legacy"
    decoded.selector = LEGACY_EXECUTE_SELECTOR
    return decoded
  }

  const viewName = VIEW_FUNCTION_BY_SELECTOR[selector]
  if (viewName !== undefined) {
    return {
      functionName: viewName,
      abi: "v2",
      selector,
      operationCount: 0,
      operations: [],
      warnings: [`${viewName}() is a registry read-only call and carries no operations`],
    }
  }

  return null
}

/**
 * A selector we decline. Counted per selector and logged on first sight, whether or not the
 * caller told us the target.
 *
 * That independence is the point. arkiv-chain-indexer only calls this service for
 * transactions already aimed at the registry (arkivOperations.ts:163) but never passes `to`,
 * so a loud path gated on `to` is silent for the one caller in production. The counter is
 * how a new registry selector becomes visible without that caller changing anything.
 */
function unknownCall(data: Hex, to: Address | null): DecodeError {
  if (data.length < 10) {
    return new DecodeError(
      `Data is neither Arkiv execute() calldata (selectors ${KNOWN_SELECTORS.join(", ")}) nor a parseable serialized transaction`,
    )
  }
  const targetIsRegistry = to !== null && to.toLowerCase() === ARKIV_ADDRESS.toLowerCase()
  const selector = selectorOf(data)
  const message = targetIsRegistry
    ? `Call to the Arkiv registry ${ARKIV_ADDRESS} uses selector ${selector}, which this decoder does not know. Known selectors: ${KNOWN_SELECTORS.join(", ")}`
    : `Selector ${selector} is not an Arkiv registry call this decoder knows. Known selectors: ${KNOWN_SELECTORS.join(", ")}`
  recordGap({ code: "UNKNOWN_SELECTOR", message }, selector)
  return new UnknownSelectorError(selector, targetIsRegistry, message)
}

/**
 * Decode either bare `execute(...)` calldata (either ABI generation) or a full
 * RLP-serialized transaction (signed or unsigned) whose data is an Arkiv registry call.
 */
export function decodeArkivTransaction(input: string, options: DecodeOptions = {}): DecodeResult {
  const trimmed = input.trim()
  if (!isHexString(trimmed)) {
    throw new DecodeError("Input must be a 0x-prefixed hex string")
  }

  const direct = decodeBySelector(trimmed, options)
  if (direct) return direct

  // Not raw calldata, so try interpreting it as a serialized transaction.
  let tx
  try {
    tx = parseTransaction(trimmed)
  } catch {
    throw unknownCall(trimmed, options.to ?? null)
  }

  const to = tx.to ? getAddress(tx.to) : (options.to ?? null)
  // No calldata means no selector, so there is nothing to name or to count.
  if (!tx.data) {
    throw new DecodeError(`Serialized transaction to ${to ?? "an unknown target"} carries no calldata`)
  }

  const decoded = decodeBySelector(tx.data, { ...options, to })
  if (!decoded) throw unknownCall(tx.data, to)

  decoded.to = to
  if (to && to.toLowerCase() !== ARKIV_ADDRESS.toLowerCase()) {
    decoded.warning = `Transaction target ${to} is not the known Arkiv registry ${ARKIV_ADDRESS}`
  }
  return decoded
}
