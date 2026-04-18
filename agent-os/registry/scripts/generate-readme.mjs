#!/usr/bin/env node

/**
 * Generates the package table in the root README.md from per-package metadata files.
 * Run: node registry/scripts/generate-readme.mjs
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_ROOT = join(__dirname, "..");
const REPO_ROOT = join(REGISTRY_ROOT, "..");
const PACKAGES_DIR = join(REGISTRY_ROOT, "software");

function loadPackages() {
	const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith("_"))
		.map((d) => d.name)
		.sort();

	const packages = [];
	for (const dir of dirs) {
		const metaPath = join(PACKAGES_DIR, dir, "agent-os-package.json");
		const artifactMetaPath = join(PACKAGES_DIR, dir, "agent-os-package.meta.json");
		if (!existsSync(metaPath)) continue;
		const meta = JSON.parse(readFileSync(metaPath, "utf8"));
		const artifactMeta = existsSync(artifactMetaPath)
			? JSON.parse(readFileSync(artifactMetaPath, "utf8"))
			: null;
		packages.push({ dir, ...meta, artifactMeta });
	}
	return packages;
}

function formatBytes(bytes) {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "-";

	const units = ["B", "KiB", "MiB", "GiB"];
	let value = bytes;
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function generateTable(packages) {
	const wasm = packages.filter((p) => p.type === "wasm");
	const meta = packages.filter((p) => p.type === "meta");

	let table = "";

	table += "### WASM Command Packages\n\n";
	table += "| Package | apt Equivalent | Description | Source | Combined Size | Gzipped |\n";
	table += "|---------|---------------|-------------|--------|---------------|---------|\n";
	for (const pkg of wasm) {
		const status = pkg.status === "planned" ? " *(planned)*" : "";
		const aptName = pkg.aptName || "-";
		const totalSize = formatBytes(pkg.artifactMeta?.totalSize);
		const totalSizeGzip = formatBytes(pkg.artifactMeta?.totalSizeGzip);
		table += `| \`${pkg.name}\` | ${aptName} | ${pkg.description}${status} | ${pkg.source || "-"} | ${totalSize} | ${totalSizeGzip} |\n`;
	}

	table += "\n### Meta-Packages\n\n";
	table += "| Package | Description | Includes |\n";
	table += "|---------|-------------|----------|\n";
	for (const pkg of meta) {
		const includes = pkg.includes ? pkg.includes.join(", ") : "-";
		table += `| \`${pkg.name}\` | ${pkg.description} | ${includes} |\n`;
	}

	return table;
}

function injectTable(readmePath, table) {
	const readme = readFileSync(readmePath, "utf8");
	const beginMarker = "<!-- BEGIN PACKAGE TABLE -->";
	const endMarker = "<!-- END PACKAGE TABLE -->";

	const beginIdx = readme.indexOf(beginMarker);
	const endIdx = readme.indexOf(endMarker);
	if (beginIdx === -1 || endIdx === -1) {
		throw new Error(`Missing package table markers in ${readmePath}`);
	}

	const before = readme.slice(0, beginIdx + beginMarker.length);
	const after = readme.slice(endIdx);
	writeFileSync(readmePath, `${before}\n${table}${after}`);
}

const packages = loadPackages();
const table = generateTable(packages);
const readmePath = join(REPO_ROOT, "README.md");
injectTable(readmePath, table);
console.log(`Injected ${packages.length} packages into ${readmePath}`);
