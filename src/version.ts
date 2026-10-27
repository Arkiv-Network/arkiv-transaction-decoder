// package.json is the one place the name and version are written: the image ships it next to src/,
// so a release bump there is all it takes for /version to report it.
import packageJson from "../package.json" with { type: "json" }

export const SERVICE_NAME: string = packageJson.name
export const SERVICE_VERSION = `v${packageJson.version}`
