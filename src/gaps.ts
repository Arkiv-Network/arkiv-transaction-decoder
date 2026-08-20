/**
 * How this decoder reports what it could not read.
 *
 * One error class, meaning one thing: the calldata is not ours, so the caller skips it.
 * Everything else is a gap, a record that travels in the response body at 200 alongside a
 * log line and a counter. See decodeErrorResponse in src/server.ts for why the difference
 * matters more than it looks.
 */
import type { Hex } from "viem"

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
