/**
 * Selector dispatch, and the entry point src/server.ts calls.
 *
 * Calldata gets exactly two answers here: a DecodeError the caller skips, or a result,
 * marked undecodable when we could not read it. Nothing a stranger puts in a transaction
 * picks anything else. CALLDATA_STATUS in src/server.ts states the rule and why.
 */
import { type Address, type Hex, getAddress, parseTransaction } from "viem"
import {
  ARKIV_ADDRESS,
  type ArkivViewFunctionName,
  EXECUTE_SELECTOR,
  RETIRED_EXECUTE_SELECTOR,
  VIEW_FUNCTION_NAMES,
} from "./abi"
import { isHexString } from "./bytes"
import { type DecodeOptions, type DecodedTransaction, type DecodedViewCall, decodeCalldata } from "./decode"
import { DecodeError, UnknownSelectorError, recordGap } from "./gaps"

export type DecodeResult = DecodedTransaction | DecodedViewCall

const VIEW_FUNCTION_BY_SELECTOR: Record<string, ArkivViewFunctionName | undefined> = VIEW_FUNCTION_NAMES

/** Selectors this service decodes. One ABI, so one entry. */
export const KNOWN_SELECTORS: Hex[] = [EXECUTE_SELECTOR]

function selectorOf(data: Hex): Hex {
  return data.slice(0, 10).toLowerCase() as Hex
}

/**
 * Generation-1 `execute(...)`: registry traffic we can name and cannot read.
 *
 * A recorded gap at 200 with an empty batch, not a 400, and the difference is what the
 * caller is told. 400 means "not Arkiv calldata", which is false here: these 4 bytes are
 * the registry's own execute, pinned in src/abi.ts, and the production caller sends no
 * `to`, so a 400 would carry code NOT_ARKIV_CALLDATA and land this in the bucket anyone
 * counting foreign traffic reads. It is the same shape a malformed argument block already
 * gets, for the same reason: the selector is ours, there are no operations to report, and
 * an empty batch is a row the indexer records and moves past.
 *
 * The subject is the selector, so a legacy chain reappearing is a climbing count next to
 * 0xba8ccf92 on GET /api/selectors rather than a number folded in with every unknown
 * selector on the chain.
 */
function retiredGeneration(): DecodedTransaction {
  return {
    functionName: "execute",
    selector: RETIRED_EXECUTE_SELECTOR,
    undecodable: recordGap(
      {
        code: "RETIRED_GENERATION",
        message:
          `Calldata carries the generation-1 execute() selector ${RETIRED_EXECUTE_SELECTOR}. That ABI was removed: ` +
          "no live network runs it. If this count is climbing, a generation-1 chain is being indexed.",
      },
      RETIRED_EXECUTE_SELECTOR,
    ),
    operationCount: 0,
    operations: [],
  }
}

function decodeBySelector(data: Hex, options: DecodeOptions): DecodeResult | null {
  if (data.length < 10) return null
  const selector = selectorOf(data)

  if (selector === EXECUTE_SELECTOR) return decodeCalldata(data, options)
  if (selector === RETIRED_EXECUTE_SELECTOR) return retiredGeneration()

  const viewName = VIEW_FUNCTION_BY_SELECTOR[selector]
  if (viewName !== undefined) {
    return {
      functionName: viewName,
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
      `Data is neither Arkiv execute() calldata (selector ${EXECUTE_SELECTOR}) nor a parseable serialized transaction`,
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
 * Decode either bare `execute(...)` calldata or a full RLP-serialized transaction (signed
 * or unsigned) whose data is an Arkiv registry call.
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
