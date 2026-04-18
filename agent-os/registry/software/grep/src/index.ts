import type { WasmCommandPackage } from "@rivet-dev/agent-os-registry-types";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = {
	name: "grep",
	aptName: "grep",
	description: "GNU grep pattern matching (grep, egrep, fgrep)",
	source: "rust" as const,
	commands: [
		{ name: "grep", permissionTier: "read-only" as const },
		{ name: "egrep", permissionTier: "read-only" as const, aliasOf: "grep" },
		{ name: "fgrep", permissionTier: "read-only" as const, aliasOf: "grep" },
	],
	get commandDir() {
		return resolve(__dirname, "..", "wasm");
	},
} satisfies WasmCommandPackage;

export default pkg;
