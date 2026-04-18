import type { WasmCommandPackage } from "@rivet-dev/agent-os-registry-types";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = {
	name: "sqlite3",
	aptName: "sqlite3",
	description: "SQLite3 command-line interface",
	source: "c" as const,
	commands: [{ name: "sqlite3", permissionTier: "read-write" as const }],
	get commandDir() {
		return resolve(__dirname, "..", "wasm");
	},
} satisfies WasmCommandPackage;

export default pkg;
