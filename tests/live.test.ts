// Transactions recorded from the live UDC chain (chain 7706815, run udc-permanent-20261026) by
// scripts/record-live-fixtures.ts, with the node's arkiv_query view of every entity they touch.
// Each decode must equal its golden, and each golden must agree with the node: attribute names,
// types, indexed flags and values with arkiv_query's, expiry with what the node resolved, owners
// with what it recorded. Comparing with the node rather than with this decoder is the point.
import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { type Hex, decodeAbiParameters, keccak256, parseAbiParameters } from "viem"
import { type DecodedAttribute, type DecodedTransaction, decodeArkivTransaction } from "../src/decoder"

const FIXTURES = `${import.meta.dir}/fixtures/live`

type NodeEntity = {
  key: string
  owner: string
  creator: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  creationFlags: { raw: number; readonly: boolean; permissionlessExtension: boolean }
  attributeSchema: { name: string; type: string; indexed: boolean }[]
  attributes: { name: string; type: string; value: unknown }[]
}

type Fixture = {
  chainId: number
  blockNumber: number
  blockHash: string
  transactions: {
    hash: string
    from: string
    input: Hex
    status: string
    logs: { topics: string[]; data: Hex }[]
    nodeViews: { key: string; atBlock: number; entity: NodeEntity | null }[]
  }[]
}

const TOPICS = {
  created: "0xb282d7c494b8899aa8015cd07be621530beb03409eb8c5e8fdc1411ba64356a5",
}

const blocks = readdirSync(FIXTURES)
  .filter((file) => /^block-\d+\.json$/.test(file))
  .map((file) => file.slice(0, -".json".length))
  .sort()

async function load(name: string) {
  const fixture: Fixture = await Bun.file(`${FIXTURES}/${name}.json`).json()
  const golden: DecodedTransaction[] = await Bun.file(`${FIXTURES}/${name}.golden.json`).json()
  return { fixture, golden }
}

function view(tx: Fixture["transactions"][number], key: string, atBlock: number): NodeEntity | null {
  const found = tx.nodeViews.find((v) => v.key === key && v.atBlock === atBlock)
  if (!found) throw new Error(`no node view of ${key} at ${atBlock}`)
  return found.entity
}

/** The expiry the node resolves an (expiresAt, minLifetime) pair to at `block`. */
function resolvedExpiry(expiresAt: string, minLifetime: string, block: number): bigint {
  const floor = BigInt(block) + BigInt(minLifetime)
  return BigInt(expiresAt) > floor ? BigInt(expiresAt) : floor
}

/** A decoded attribute against the node's: same name, type, flag and value; bytes by size and hash. */
function expectMatchesNode(attribute: DecodedAttribute, entity: NodeEntity) {
  const schema = entity.attributeSchema.find((s) => s.name === attribute.name)
  const stored = entity.attributes.find((a) => a.name === attribute.name)
  expect(schema, `node has ${attribute.name}`).toBeDefined()
  expect(stored).toBeDefined()
  expect(attribute.error).toBeUndefined()
  expect(attribute.type).toBe(schema!.type as DecodedAttribute["type"])
  expect(attribute.indexed).toBe(schema!.indexed)
  if (attribute.type === "bytes") {
    const content = stored!.value as Hex
    expect(attribute.value).toBeNull()
    expect(attribute.size).toBe((content.length - 2) / 2)
    expect(attribute.keccak256).toBe(keccak256(content))
  } else {
    expect(attribute.value).toEqual(stored!.value as DecodedAttribute["value"])
  }
}

describe("live UDC chain", () => {
  test("has the fixtures the plan names", () => {
    expect(blocks).toEqual(expect.arrayContaining(["block-0016", "block-0022", "block-0048", "block-0052", "block-0054", "block-0063", "block-0065", "block-0101"]))
  })

  for (const name of blocks) {
    describe(name, () => {
      test("decodes to its golden", async () => {
        const { fixture, golden } = await load(name)
        const decoded = fixture.transactions.map((tx) => decodeArkivTransaction(tx.input))
        expect(JSON.parse(JSON.stringify(decoded))).toEqual(golden)
      })

      test("the golden agrees with the node's view of every entity it touches", async () => {
        const { fixture, golden } = await load(name)
        const block = fixture.blockNumber
        fixture.transactions.forEach((tx, t) => {
          expect(tx.status).toBe("0x1")
          const createdLogs = tx.logs.filter((log) => log.topics[0] === TOPICS.created)
          let creates = 0
          for (const op of golden[t]!.operations) {
            switch (op.operation) {
              case "create": {
                // Creates pair with EntityCreated logs in order.
                const log = createdLogs[creates++]!
                const key = log.topics[1]!
                const entity = view(tx, key, block)!
                expect(entity).not.toBeNull()
                expect(entity.owner).toBe(tx.from)
                expect(BigInt(entity.createdAt)).toBe(BigInt(block))
                expect(entity.creationFlags.raw).toBe(op.creationFlags!)
                expect(BigInt(entity.expiresAt)).toBe(resolvedExpiry(op.expiresAt!, op.minLifetime!, block))
                expect(op.permanent).toBe(BigInt(entity.expiresAt) === 2n ** 64n - 1n)
                const [expiresAt, flags] = decodeAbiParameters(parseAbiParameters("uint64, uint8"), log.data)
                expect(expiresAt).toBe(BigInt(entity.expiresAt))
                expect(flags).toBe(op.creationFlags!)
                // Every attribute the node holds came from this create, and matches it.
                expect(op.attributes.map((a) => a.name)).toEqual(entity.attributeSchema.map((s) => s.name))
                for (const attribute of op.attributes) expectMatchesNode(attribute, entity)
                expect(op.bytesSize).toBe(
                  op.attributes.filter((a) => a.type === "bytes").reduce((n, a) => n + a.size, 0),
                )
                break
              }
              case "patch": {
                const entity = view(tx, op.entityKey!, block)!
                expect(BigInt(entity.updatedAt)).toBe(BigInt(block))
                for (const attribute of op.attributes) {
                  if (attribute.type === "tombstone") {
                    expect(entity.attributeSchema.some((s) => s.name === attribute.name)).toBe(false)
                  } else {
                    expectMatchesNode(attribute, entity)
                  }
                }
                break
              }
              case "extend": {
                const entity = view(tx, op.entityKey!, block)!
                expect(BigInt(entity.expiresAt)).toBe(resolvedExpiry(op.expiresAt!, op.minLifetime!, block))
                break
              }
              case "transfer": {
                const entity = view(tx, op.entityKey!, block)!
                expect(entity.owner).toBe(op.newOwner!)
                break
              }
              case "delete": {
                expect(view(tx, op.entityKey!, block)).toBeNull()
                expect(view(tx, op.entityKey!, block - 1)).not.toBeNull()
                break
              }
              default:
                throw new Error(`unexpected ${op.operation} on the live chain`)
            }
          }
          expect(creates).toBe(createdLogs.length)
        })
      })
    })
  }

  test("together the fixtures cover every operation, every type and every typeId the chain holds", async () => {
    const operations = new Set<string>()
    const types = new Set<string>()
    const typeIds = new Set<number>()
    for (const name of blocks) {
      const { golden } = await load(name)
      for (const op of golden.flatMap((tx) => tx.operations)) {
        operations.add(op.operation)
        for (const attribute of op.attributes) {
          types.add(attribute.type)
          typeIds.add(attribute.typeId)
        }
      }
    }
    expect([...operations].sort()).toEqual(["create", "delete", "extend", "patch", "transfer"])
    expect([...types].sort()).toEqual(
      ["addr", "bool", "bytes", "bytes32", "dec", "i32", "key", "str", "tombstone", "u256", "u64"].sort(),
    )
    // Every typeId on the live chain: the tombstone, unindexed i32/u64/bytes/str, and all indexed types.
    expect([...typeIds].sort((a, b) => a - b)).toEqual([
      0x00, 0x02, 0x03, 0x07, 0x08, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x88, 0x89, 0x8a,
    ])
  })

  test("block 48 is the permanent create", async () => {
    const { golden } = await load("block-0048")
    const op = golden[0]!.operations[0]!
    expect(op).toMatchObject({ operation: "create", expiresAt: "18446744073709551615", minLifetime: "0", permanent: true })
    // Its body is an empty bytes value: present, sized zero.
    expect(op.attributes[0]).toMatchObject({ name: "body", type: "bytes", value: null, size: 0 })
    expect(op.bytesSize).toBe(0)
  })

  test("block 65 reports its 32 KiB bytes value by size alone", async () => {
    const { golden } = await load("block-0065")
    const cover = golden[0]!.operations[0]!.attributes.find((a) => a.name === "cover")!
    expect(cover).toMatchObject({ type: "bytes", value: null, size: 32 * 1024 })
  })

  test("block 101 keeps case-sensitive names apart", async () => {
    const { golden } = await load("block-0101")
    const names = golden[0]!.operations[0]!.attributes.map((a) => a.name)
    expect(names).toContain("Level")
    expect(names).toContain("level")
    expect(names).toContain("naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  })
})
