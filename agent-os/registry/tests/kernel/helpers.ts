/**
 * Integration test helpers for kernel tests that depend on WASM command binaries.
 *
 * Re-exports infrastructure from the parent helpers.ts and provides
 * createIntegrationKernel / skipUnlessWasmBuilt for cross-runtime tests.
 */

import {
  COMMANDS_DIR,
  C_BUILD_DIR,
  hasWasmBinaries,
  skipReason,
  createKernel,
  createWasmVmRuntime,
  createNodeRuntime,
} from "../helpers.js";
import type { Kernel } from "../helpers.js";
import { createInMemoryFileSystem } from "@secure-exec/core";
import type { VirtualFileSystem } from "@secure-exec/core";

export {
  COMMANDS_DIR,
  C_BUILD_DIR,
  hasWasmBinaries,
  skipReason,
  createKernel,
  createWasmVmRuntime,
  createNodeRuntime,
} from "../helpers.js";
export type { Kernel } from "../helpers.js";
export { createInMemoryFileSystem } from "@secure-exec/core";
export type { VirtualFileSystem } from "@secure-exec/core";

export interface IntegrationKernelResult {
  kernel: Kernel;
  vfs: VirtualFileSystem;
  dispose: () => Promise<void>;
}

export interface IntegrationKernelOptions {
  runtimes?: ("wasmvm" | "node" | "python")[];
}

/**
 * Create a kernel with real runtime drivers for integration testing.
 *
 * Mount order matters. Last-mounted driver wins for overlapping commands:
 *   1. WasmVM first: provides sh/bash/coreutils (90+ commands)
 *   2. Node second: overrides WasmVM's 'node' stub with real V8
 *   3. Python third: overrides WasmVM's 'python' stub with real Pyodide
 */
export async function createIntegrationKernel(
  options?: IntegrationKernelOptions,
): Promise<IntegrationKernelResult> {
  const runtimes = options?.runtimes ?? ["wasmvm"];
  const vfs = createInMemoryFileSystem();
  const kernel = createKernel({ filesystem: vfs });

  if (runtimes.includes("wasmvm")) {
    await kernel.mount(createWasmVmRuntime({ commandDirs: [COMMANDS_DIR] }));
  }
  if (runtimes.includes("node")) {
    await kernel.mount(createNodeRuntime());
  }
  // Python runtime not re-exported from parent helpers yet; add when needed.

  return {
    kernel,
    vfs,
    dispose: () => kernel.dispose(),
  };
}

/**
 * Skip helper: returns a reason string if the WASM binaries are not built,
 * or false if the commands directory exists and tests can run.
 */
export function skipUnlessWasmBuilt(): string | false {
  return skipReason();
}
