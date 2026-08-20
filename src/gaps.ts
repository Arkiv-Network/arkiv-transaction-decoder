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
export type DecoderGapCode =
  | "UNKNOWN_SELECTOR"
  | "MALFORMED_CALLDATA"
  | "MALFORMED_OPERATION_DATA"
  | "UNKNOWN_OPERATION_TAG"

/** The machine-readable marker a caller stores instead of stopping. */
export type DecoderGap = {
  code: DecoderGapCode
  message: string
}

export type DecoderGapTally = { code: DecoderGapCode; subject: string; count: number }

const tallies = new Map<string, DecoderGapTally>()

/**
 * Distinct named subjects worth remembering.
 *
 * A ceiling is required because the subject is attacker-chosen: anyone can send a
 * transaction carrying a selector nobody has used before, and an uncapped map is a slow
 * leak a stranger drives for free. The map also holds one anonymous bucket per gap code,
 * which is never evicted, so the true bound is MAX_TALLIES plus the number of codes.
 */
const MAX_TALLIES = 256

/**
 * Make room by dropping the least frequent named subject, folding its count into its
 * code's anonymous bucket so the totals stay honest.
 *
 * Eviction rather than refusal is what keeps the channel loud. Refusing new keys once full
 * let anyone mute the next genuine registry selector for the price of MAX_TALLIES reverted
 * transactions: it produced no log line and no named entry, and folded into the anonymous
 * bucket instead. Evicting the lowest count means single-shot noise churns straight back
 * out while a selector that recurs climbs in and stays.
 */
function evictLeastFrequent(): void {
  let victimKey: string | null = null
  let victim: DecoderGapTally | null = null
  for (const [key, tally] of tallies) {
    // Anonymous buckets are the floor evicted counts land in. Never evict one.
    if (tally.subject === "") continue
    if (victim === null || tally.count < victim.count) {
      victimKey = key
      victim = tally
    }
  }
  if (victimKey === null || victim === null) return
  tallies.delete(victimKey)
  const bucket = tallies.get(victim.code)
  if (bucket === undefined) {
    tallies.set(victim.code, { code: victim.code, subject: "", count: victim.count })
  } else {
    bucket.count += victim.count
  }
}

/**
 * The operator-facing half of a gap: a log line and a counter. Status codes cannot carry
 * this, because the caller that would see the status is the one we must not stop.
 *
 * Only the first sighting of each subject logs. A chain carries a lot of ordinary foreign
 * traffic, and a line per transaction buries the one new selector that matters.
 */
export function recordGap(gap: DecoderGap, subject = ""): DecoderGap {
  const key = subject === "" ? gap.code : `${gap.code} ${subject}`
  const seen = tallies.get(key)
  if (seen !== undefined) {
    seen.count += 1
    return gap
  }
  if (tallies.size >= MAX_TALLIES) evictLeastFrequent()
  tallies.set(key, { code: gap.code, subject, count: 1 })
  console.warn(`[decoder-gap] ${key}: ${gap.message}`)
  return gap
}

/** Every gap seen since start, most frequent first. Served by GET /api/selectors. */
export function decoderGaps(): DecoderGapTally[] {
  return [...tallies.values()].sort((a, b) => b.count - a.count)
}
