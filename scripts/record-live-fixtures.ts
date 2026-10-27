// Records execute() transactions from a live UDC chain as test fixtures, together with the node's
// own view of every entity they touch, so tests/live.test.ts can check each decode against the
// node rather than against this decoder alone.
//
//   bun run scripts/record-live-fixtures.ts [--rpc http://127.0.0.1:18545] [--golden] <block>...
//
// Only read-only methods are called: eth_chainId, eth_getBlockByNumber, eth_getTransactionReceipt
// and arkiv_query. For each block it writes tests/fixtures/live/block-NNNN.json; with --golden it
// also writes block-NNNN.golden.json from the current decoder, which the cross-check in
// tests/live.test.ts must then accept before the golden is committed.
import { mkdir } from "node:fs/promises"
import type { Hex } from "viem"
import { ARKIV_ADDRESS, EXECUTE_SELECTOR, decodeCalldata } from "../src/decoder"

/** Everything arkiv_query can return for an entity. */
export const FULL_SELECT = {
  key: true,
  owner: true,
  creator: true,
  createdAt: true,
  updatedAt: true,
  expiresAt: true,
  creationFlags: true,
  attributeSchema: true,
  attributes: true,
}

const OUT_DIR = `${import.meta.dir}/../tests/fixtures/live`

let rpcUrl = "http://127.0.0.1:18545"
let writeGolden = false
const blocks: number[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!
  if (arg === "--rpc") rpcUrl = argv[++i]!
  else if (arg === "--golden") writeGolden = true
  else if (/^\d+$/.test(arg)) blocks.push(Number(arg))
  else throw new Error(`unknown argument ${arg}`)
}
if (blocks.length === 0) throw new Error("name at least one block")

async function rpc(method: string, params: unknown[]): Promise<any> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: unknown; error?: unknown }
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

const quantity = (n: number) => `0x${n.toString(16)}`

async function entityAt(key: string, block: number) {
  const result = await rpc("arkiv_query", [`$key = key(${key})`, { atBlock: quantity(block), select: FULL_SELECT }])
  return { key, atBlock: block, entity: result.data[0] ?? null }
}

const ENTITY_CREATED = "0xb282d7c494b8899aa8015cd07be621530beb03409eb8c5e8fdc1411ba64356a5"

const chainId = Number(await rpc("eth_chainId", []))
await mkdir(OUT_DIR, { recursive: true })

for (const number of blocks) {
  const block = await rpc("eth_getBlockByNumber", [quantity(number), true])
  const transactions = []
  const goldens = []
  for (const tx of block.transactions) {
    if (tx.to?.toLowerCase() !== ARKIV_ADDRESS || !tx.input.startsWith(EXECUTE_SELECTOR)) continue
    const receipt = await rpc("eth_getTransactionReceipt", [tx.hash])
    const decoded = decodeCalldata(tx.input as Hex)

    // Creates pair with EntityCreated logs in order; every other operation names its key.
    const createdKeys: string[] = receipt.logs
      .filter((log: { topics: string[] }) => log.topics[0] === ENTITY_CREATED)
      .map((log: { topics: string[] }) => log.topics[1])
    const keys = new Set<string>(createdKeys)
    for (const op of decoded.operations) if (op.entityKey) keys.add(op.entityKey)

    const nodeViews = []
    for (const key of keys) {
      nodeViews.push(await entityAt(key, number))
      // A deleted entity is gone at its block, so its last state is the block before.
      if (decoded.operations.some((op) => op.operation === "delete" && op.entityKey === key)) {
        nodeViews.push(await entityAt(key, number - 1))
      }
    }

    transactions.push({
      hash: tx.hash,
      transactionIndex: Number(tx.transactionIndex),
      from: tx.from.toLowerCase(),
      to: tx.to.toLowerCase(),
      input: tx.input,
      status: receipt.status,
      rentFee: receipt.rentFee,
      logs: receipt.logs.map((log: { topics: string[]; data: string }) => ({ topics: log.topics, data: log.data })),
      nodeViews,
    })
    goldens.push(decoded)
  }
  if (transactions.length === 0) throw new Error(`block ${number} has no execute() transaction`)

  const name = `block-${String(number).padStart(4, "0")}`
  const fixture = { chainId, blockNumber: number, blockHash: block.hash, transactions }
  await Bun.write(`${OUT_DIR}/${name}.json`, `${JSON.stringify(fixture, null, 2)}\n`)
  if (writeGolden) await Bun.write(`${OUT_DIR}/${name}.golden.json`, `${JSON.stringify(goldens, null, 2)}\n`)
  console.log(`${name}: ${transactions.length} transaction(s), ${transactions.flatMap((t) => t.nodeViews).length} node view(s)`)
}
