/** Generation-2 decoding: the tagged union behind `execute((uint8,bytes)[])`. */
import {
  type Address,
  type Hex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
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
  WORD_LEN,
} from "./abi"
import { decodeIdent32, decodeUtf8 } from "./bytes"
import { type DecoderGap, type DecoderGapCode, recordGap } from "./gaps"

class ValueDecodeError extends Error {}

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
