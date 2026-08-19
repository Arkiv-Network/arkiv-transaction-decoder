/**
 * Registry event topic0 values, pinned so the calldata-versus-logs cross-checks cannot
 * drift silently. tests/selectors.test.ts recomputes each one from its signature.
 * Source of truth: Arkiv-Network/arkiv crates/arkiv-bindings/src/lib.rs.
 */
export const EVENT_TOPICS = {
  "EntityCreated(bytes32,address,uint64,uint8)":
    "0xb282d7c494b8899aa8015cd07be621530beb03409eb8c5e8fdc1411ba64356a5",
  "EntityPatched(bytes32,address)": "0xe986ee220b2d7947a009d9389d8400b2ac82d3b430a9f72700a0975d3d5a34fe",
  "ExpiryExtended(bytes32,address,uint64)":
    "0x10dc3526654c9ba4e2370b1bfcbc0de087d141a5694b3d3305d37df7e6705d4b",
  "OwnershipTransferred(bytes32,address,address)":
    "0x0b659dccc8eb950324170e8d9598af5ee04ee070883eb28651a96788721fbf83",
  "EntityDeleted(bytes32,address)": "0x4059b76c47e1ecc40ba88e649b654f716515eb358c3ce83c803820e3b3130cc3",
} as const
