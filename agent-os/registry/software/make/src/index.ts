import type { WasmCommandPackage } from "@rivet-dev/agent-os-registry-types";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = {
	name: "make",
	aptName: "make",
	description: "GNU make build tool (planned)",
	source: "rust" as const,
	commands: [{ name: "make", permissionTier: "full" as const }],
	get commandDir() {
		return resolve(__dirname, "..", "wasm");
	},
} satisfies WasmCommandPackage;

export default pkg;
