# arkiv-transaction-decoder

A small [Bun](https://bun.sh) server that decodes Arkiv entity-registry transaction data
back into readable Arkiv operations.

It accepts either bare `execute()` calldata or a full RLP-serialized transaction (signed
or unsigned, legacy/2930/1559) and returns the decoded operations as JSON.

## Two ABI generations

The registry contract (`0x4400000000000000000000000000000000000044`) has two encodings in
the wild. This service decodes both and picks one by selector.

### Generation 2, selector `0x49650044`

Live on the cheesecake devnet. Operations are a tagged union: a tag plus an
`abi.encode`d struct.

```solidity
struct Attribute { Ident32 name; uint8 typeId; bytes value; }
struct Operation { uint8 operation; bytes operationData; }

struct Create           { uint128 salt; uint64 expiresAt; uint64 minLifetime; uint8 creationFlags; Attribute[] attributes; }
struct Patch            { bytes32 entityKey; Attribute[] mutations; }
struct ExtendExpiry     { bytes32 entityKey; uint64 expiresAt; uint64 minLifetime; }
struct TransferOwnership{ bytes32 entityKey; address newOwner; }
struct Delete           { bytes32 entityKey; }

function execute(Operation[] ops) external returns (bytes32[] keys);
```

Operation tags: 1 create, 2 patch, 3 extend_expiry, 4 transfer_ownership, 5 delete. There
is no expire operation. Expiry runs as a per-block system call.

`Ident32` is a user-defined value type over `bytes32`, so it flattens to a plain `bytes32`
on the wire. Names are left-aligned ASCII, null-padded on the right. System names start
with `$`.

Attribute values are typed by `typeId`:

| id | name | wire format |
|----|------|-------------|
| 0 | tombstone | empty; removes the attribute |
| 1 | bool | 32-byte word, 0 or 1 |
| 2 | i32 | 32-byte word, sign-extended |
| 3 | u64 | 32-byte word, right-aligned |
| 4 | u256 | 32-byte word |
| 5 | dec | 32-byte word, signed, scaled by 1e18 |
| 6 | bytes32 | 32-byte word |
| 7 | bytes | raw bytes, no padding |
| 8 | str | raw UTF-8 bytes, no padding |
| 9 | addr | 32-byte word, low 20 bytes |
| 10 | key | 32-byte word |

Word types must be exactly 32 bytes with canonical padding. The chain rejects anything
else, so this decoder marks it `invalid` rather than reporting a value the chain would
have refused.

### Generation 1 (legacy), selector `0xba8ccf92`

```solidity
function execute((
  uint8 operationType,
  bytes32 entityKey,
  bytes payload,
  (bytes32[4] data) contentType,            // Mime128
  (bytes32 name, uint8 valueType, bytes32[4] value)[] attributes,
  uint32 expiresAt,                          // block-denominated
  address newOwner
)[] ops) external
```

Unchanged. Existing callers keep the same responses they had before.

### Upstream source of truth

The ABIs mirrored in `src/abi.ts` are copies. Their source of truth is
**Arkiv-Network/arkiv, `crates/arkiv-bindings/src/lib.rs`**.

`tests/selectors.test.ts` recomputes each selector from its signature string and asserts
the pinned hex, mirroring that crate's `selectors_are_pinned` test. It checks two
independent paths: the signature strings must hash to the pinned bytes, and the ABI
object this service decodes with must produce the same selector. Editing a struct fails
the second, editing a pin fails the first. An upstream change fails the build here
instead of turning into a silent 400 in production.

A pinned selector cannot catch the drift most likely to happen. The tagged union exists so
new operation types ship without touching the `execute` signature, and `operationData` is
opaque bytes, so a field added to `Create` moves no selector and every pin still passes.
`tests/fixtures/cheesecake.json` catches that, and `tests/fixtures/operation-vectors.json`
backs it up: one frozen `operationData` per tag, captured once, so a struct that grew a
field fails even after the cheesecake fixture is regenerated against a newer chain.

## Three things the calldata cannot tell you

The decoder is offline: it reads calldata and nothing else. Where the calldata is not
enough, it reports what it has rather than guessing.

**A create has no entity key.** It carries a `salt`. The key is derived on chain from the
chain id, the registry address, the owner and the owner's nonce, and bare calldata has
neither the owner nor the nonce. `entityKey` is `null` on a create and `salt` is filled
in. To match a create to its entity, read the `EntityCreated` log.

**Expiry is relative.** The chain resolves it as `max(expiresAt, block + minLifetime)`.
Every live cheesecake create carries `expiresAt: 0` and a real `minLifetime`, so the raw
`expiresAt` is not the expiry the chain recorded. The decoder reports `expiresAt` and
`minLifetime` raw, and fills `resolvedExpiresAt` only when you pass `blockNumber`.

**The payload is an attribute.** Under generation 2 the bytes ride in a `$payload`
attribute of type `bytes`, next to `$contentType` of type `str`. The decoder lifts both
into the `payload` and `contentType` fields, mirroring what the executor does on chain,
and lists the lifted names in `systemAttributes`. `payload.size` keeps the same meaning
it had under the legacy ABI.

Note for anyone measuring stored bytes: a patch's `$payload` replaces the entity's
payload. Summing patch payload sizes gives bytes written, not bytes stored.

## Run

```sh
bun install
bun start          # listens on :3000, override with PORT=...
```

`MAX_INPUT_BYTES` caps a single decode request. Default 2 MiB.

## Docker

```sh
docker build -t arkiv-transaction-decoder:v0.1.0 .
docker run --rm -p 3000:3000 arkiv-transaction-decoder:v0.1.0
```

Pushing a Git tag such as `v0.1.0` builds and publishes the image to GitHub Container
Registry:

```sh
git tag v0.1.0
git push origin v0.1.0
```

## API

`/decode`, `/healthz` and `/selectors` are served alongside the `/api/*` paths, so this
can replace the Rust decoder without a config change on the caller.

### `POST /api/decode`

Body: `{"data": "0x..."}` (JSON) or the raw hex string as `text/plain`. Also available as
`GET /api/decode?data=0x...`.

Optional fields, all ignored when absent:

| field | effect |
|-------|--------|
| `to` | target address of the call. Lets an unknown selector aimed at the registry be reported loudly |
| `blockNumber` | block the transaction ran in. Fills `resolvedExpiresAt` |
| `chainId` | echoed back untouched |

```sh
curl -s localhost:3000/decode \
  -H 'content-type: application/json' \
  -d '{"data": "0x49650044...", "blockNumber": 222498}'
```

Response:

```json
{
  "functionName": "execute",
  "abi": "v2",
  "selector": "0x49650044",
  "operationCount": 1,
  "operations": [
    {
      "index": 0,
      "operationType": 1,
      "operation": "create",
      "entityKey": null,
      "salt": "337797463300736330483541628654607568406",
      "creationFlags": 1,
      "creationFlagNames": ["readonly"],
      "contentType": "application/json",
      "payload": {
        "size": 44,
        "present": true,
        "hex": "0x7b2270726f6265...",
        "text": "{\"probe\":\"smoke-readonly\",\"run\":\"rmsysl2em\"}"
      },
      "attributes": [
        { "key": "kind", "valueType": 8, "valueTypeName": "str", "value": "smoke", "sizeBytes": 5 }
      ],
      "systemAttributes": ["$contentType", "$payload"],
      "attributeCount": 4,
      "expiresAt": "0",
      "minLifetime": "30",
      "resolvedExpiresAt": "222528",
      "expiresAtBlocks": "222528",
      "newOwner": null
    }
  ]
}
```

Notes:

- `salt`, `expiresAt`, `minLifetime`, `resolvedExpiresAt` and `expiresAtBlocks` are
  decimal strings. A `uint128` salt does not fit a JS number, and neither does a `uint64`
  expiry: the executor writes `expiresAt = u64::MAX` for a permanent entity, which
  `Number()` renders as 18446744073709552000, wrong by 385 and past the `int8` ceiling of
  the column the indexer stores it in.
- `expiresAtBlocks` is a compatibility field for arkiv-chain-indexer: the resolved block
  when `blockNumber` was supplied, otherwise the raw `expiresAt`.
- `undecodable` marks calldata this decoder recognised but could not read. On an operation
  it means that one operation; on the response it means the argument block itself, and
  there are no operations. See "Decoder gaps" below.
- `payload.hex` is omitted and `payload.truncated` is set above 8 KiB. A batch of 100 KiB
  payloads would otherwise be a multi-megabyte response, and the size is the part callers
  use. The legacy ABI path is unchanged and always includes the hex.
- `payload.text` is present only when the payload is valid UTF-8.
- `warnings` collects non-fatal notes: an unfamiliar attribute type, a non-canonical
  encoding, a value above a protocol limit.
- A serialized transaction also gets `to`, plus a `warning` when the target is not the
  known registry address.
- The legacy ABI response is unchanged, with `abi: "legacy"` added.

### Error codes

Calldata reaches this service from a public chain, so its bytes belong to whoever sent the
transaction. They never choose the status code.

arkiv-chain-indexer maps `400` to "not an Arkiv call, skip it" and throws on every other
status, and its caller then retries the same block forever with no cap. So a stranger who
can make this service answer `422` or `501` can stop the indexer for good, and the
transaction that does it need not even succeed on chain: a reverted transaction is still
in the block.

Hence exactly two answers to calldata, and everything else is a fault in the request:

| status | `code` | meaning | caller should |
|--------|--------|---------|---------------|
| 200 | (see `undecodable`) | ours, but we could not read it | record the row |
| 400 | `NOT_ARKIV_CALLDATA` | not a contract call we recognise, or a selector we do not know on a call whose target we cannot confirm | skip |
| 400 | `UNKNOWN_SELECTOR` | a selector we do not know on a call to the registry itself | skip; this decoder has a gap |
| 400 | `BAD_REQUEST` | invalid JSON, missing `data`, or a malformed `to` / `blockNumber` / `chainId` | fix the request |
| 405 | `METHOD_NOT_ALLOWED` | not GET or POST | fix the request |
| 413 | `INPUT_TOO_LARGE` | body above `MAX_INPUT_BYTES` | split the request |
| 500 | `INTERNAL_ERROR` | bug | alert |

Every error body carries `error` (a sentence) and `code` (stable). A declined selector also
carries `selector`, `targetIsRegistry` and `knownSelectors`.

Only the target separates a decoder gap from ordinary foreign traffic. Shape does not:
every well-formed EVM call is word-aligned, so a plain ERC20 transfer looks exactly like a
registry call whose selector we are missing.

### Decoder gaps

Calldata we recognise as registry traffic but cannot fully decode is reported in the body
at `200` with a machine-readable marker, so the caller records what it saw and keeps going.

| `undecodable.code` | where | meaning |
|--------------------|-------|---------|
| `MALFORMED_CALLDATA` | response | the `execute` selector is ours, the argument block does not decode; `operations` is empty |
| `UNKNOWN_OPERATION_TAG` | operation | tag outside 1..5, so the protocol added an operation |
| `MALFORMED_OPERATION_DATA` | operation | the tag is known, `operationData` does not match the struct |

An undecodable operation keeps its raw `operationType` and takes the legacy `unknown(N)`
name, never the name its tag claims: a struct we could not parse is not evidence that the
operation it names happened, and a metrics pipeline must not count it as one. Every other
field is at its empty value, so the row still has the shape a caller parses.

The loud half of a gap is a log line and a counter, not a status:

```
[decoder-gap] UNKNOWN_OPERATION_TAG: Operation 0 has tag 6, which this decoder does not know (expected 1..5)
```

Each distinct gap logs once, then only counts. `GET /api/selectors` serves the tally. A
selector we decline is counted there too, whether or not the caller passed `to`, because
arkiv-chain-indexer only calls this service for transactions already aimed at the registry
but never says so: a loud path gated on `to` is silent for the one caller in production.

An unfamiliar **attribute type** is not a gap. The type set is an open enum the protocol may
extend, so the attribute is recorded with `valueTypeName: "unknown"` and its raw hex and
decoding continues. Halting over one unfamiliar value is worse than recording it.

### `GET /api/selectors`

Lists the selectors this build knows, so drift is visible from outside without reading
logs.

```json
{
  "selectors": [
    { "selector": "0x49650044", "signature": "execute((uint8,bytes)[])", "abi": "v2", "decodes": true }
  ],
  "maxInputBytes": 2097152,
  "gaps": [
    { "code": "UNKNOWN_SELECTOR", "subject": "0xa9059cbb", "count": 12043 },
    { "code": "UNKNOWN_OPERATION_TAG", "subject": "", "count": 2 }
  ]
}
```

`gaps` counts every decoder gap since start, most frequent first, and it is how drift
becomes visible without the caller changing anything. A new registry selector appears as a
rising count next to the ordinary foreign traffic.

### `GET /api/health`

Returns `{"status": "ok"}`.

### `GET /api/version`

Returns the service name and version.

## Development

```sh
bun test           # run the test suite
bun run typecheck  # tsc --noEmit
bun run dev        # auto-reloading server
```

CI (GitHub Actions) runs typecheck + tests on every push and pull request.

Layout:

| file | holds |
|------|-------|
| `src/abi.ts` | both registry ABIs, both selectors, the protocol constants |
| `src/bytes.ts` | byte and word helpers both generations share |
| `src/gaps.ts` | the one error class, the decoder-gap record and its counter |
| `src/decodeLegacy.ts` | generation-1 decoding |
| `src/decodeV2.ts` | generation-2 decoding |
| `src/decoder.ts` | selector dispatch, and the single import path for callers |
| `src/server.ts` | HTTP surface and the status-code contract |

`tests/fixtures/cheesecake.json` holds five real cheesecake transactions with their
receipt logs. The calldata and the logs are independent encodings of the same operations,
so they must agree: same count, same order, entity keys equal to the log topic, resolved
expiry equal to the expiry the chain recorded. That is the check a decoder which
mis-parses but still returns plausible JSON cannot pass. The fixtures are committed, so
the suite needs no devnet and no API key.
