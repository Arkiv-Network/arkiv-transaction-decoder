/**
 * Selector dispatch, and the entry point every caller imports.
 *
 * The rule the rest of the service is built on: calldata gets exactly two answers. It is
 * not ours, and we throw a DecodeError the caller skips; or it is ours, and we return a
 * result, marked undecodable when we could not read it. Nothing a stranger can put in a
 * transaction picks anything else.
 */
import { type Address, type Hex, getAddress, parseTransaction } from "viem"
import {
  ARKIV_ADDRESS,
  type ArkivViewFunctionName,
  EXECUTE_V2_SELECTOR,
  LEGACY_EXECUTE_SELECTOR,
  VIEW_FUNCTION_NAMES,
} from "./abi"
import { isHexString } from "./bytes"
import { type DecodedTransaction, decodeCalldata } from "./decodeLegacy"
import {
  type DecodeOptions,
  type DecodedTransactionV2,
  type DecodedViewCall,
  decodeCalldataV2,
} from "./decodeV2"
import { DecodeError, UnknownSelectorError, recordGap } from "./gaps"

export type DecodeResult = DecodedTransaction | DecodedTransactionV2 | DecodedViewCall

const VIEW_FUNCTION_BY_SELECTOR: Record<string, ArkivViewFunctionName | undefined> = VIEW_FUNCTION_NAMES

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

/** A target the caller gave us is worth the same warning as one we read off a transaction. */
function withTarget(decoded: DecodeResult, to: Address | null): DecodeResult {
  if (to === null) return decoded
  decoded.to = to
  if (to.toLowerCase() !== ARKIV_ADDRESS.toLowerCase()) {
    decoded.warning = `Transaction target ${to} is not the known Arkiv registry ${ARKIV_ADDRESS}`
  }
  return decoded
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
  if (direct) return withTarget(direct, options.to ?? null)

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
  return withTarget(decoded, to)
}

// ---------------------------------------------------------------------------
// Public surface. One import path for callers, whichever file the code lives in.
// ---------------------------------------------------------------------------

export {
  ARKIV_ADDRESS,
  AttributeValueType,
  ENTITY_EXECUTE_ABI,
  EXECUTE_SELECTOR,
  EXECUTE_V2_SELECTOR,
  EntityOperationType,
  LEGACY_EXECUTE_SELECTOR,
} from "./abi"
export { decodeIdent32 } from "./bytes"
export {
  type DecoderGap,
  type DecoderGapCode,
  type DecoderGapTally,
  DecodeError,
  UnknownSelectorError,
  decoderGaps,
  recordGap,
} from "./gaps"
export {
  BLOCK_TIME,
  type DecodedAttribute,
  type DecodedOperation,
  type DecodedTransaction,
  decodeCalldata,
} from "./decodeLegacy"
export {
  DEFAULT_PAYLOAD_HEX_LIMIT,
  type DecodeOptions,
  type DecodedAttributeV2,
  type DecodedOperationV2,
  type DecodedPayload,
  type DecodedTransactionV2,
  type DecodedViewCall,
  type UnknownOperationName,
  creationFlagNames,
  decodeAttributeV2,
  decodeCalldataV2,
  decodeOperationV2,
  resolveExpiry,
} from "./decodeV2"
