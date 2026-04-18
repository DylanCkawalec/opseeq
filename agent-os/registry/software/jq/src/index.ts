import type { WasmCommandPackage } from "@rivet-dev/agent-os-registry-types";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = {
	name: "jq",
	aptName: "jq",
	description: "jq JSON processor",
	source: "rust" as const,
	commands: [{ name: "jq", permissionTier: "read-only" as const }],
	get commandDir() {
		return resolve(__dirname, "..", "wasm");
	},
} satisfies WasmCommandPackage;

export default pkg;
