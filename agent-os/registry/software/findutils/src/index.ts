import type { WasmCommandPackage } from "@rivet-dev/agent-os-registry-types";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = {
	name: "findutils",
	aptName: "findutils",
	description: "GNU findutils (find, xargs)",
	source: "rust" as const,
	commands: [
		{ name: "find", permissionTier: "read-only" as const },
		{ name: "xargs", permissionTier: "full" as const },
	],
	get commandDir() {
		return resolve(__dirname, "..", "wasm");
	},
} satisfies WasmCommandPackage;

export default pkg;
