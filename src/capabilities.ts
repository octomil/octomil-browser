/**
 * @octomil/browser — Capabilities client
 *
 * Detects the full device capability profile required by the SDK
 * facade contract: device class, available runtimes, memory, storage,
 * platform, and hardware accelerators.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapabilityProfile {
  deviceClass: "flagship" | "high" | "mid" | "low";
  availableRuntimes: string[];
  memoryMb: number;
  storageMb: number;
  platform: string;
  accelerators: string[];
}

// ---------------------------------------------------------------------------
// CapabilitiesClient
// ---------------------------------------------------------------------------

export class CapabilitiesClient {
  /**
   * Detect the current device's capability profile.
   *
   * Uses browser APIs (navigator.deviceMemory, navigator.gpu,
   * StorageManager) to build the profile. Returns sensible defaults
   * when APIs are unavailable.
   */
  async current(): Promise<CapabilityProfile> {
    // Memory
    const memoryGb =
      typeof navigator !== "undefined"
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((navigator as any).deviceMemory as number | undefined) || 0
        : 0;
    const memoryMb = memoryGb * 1024;

    // Device class derived from memory
    let deviceClass: CapabilityProfile["deviceClass"];
    if (memoryMb >= 16384) deviceClass = "flagship";
    else if (memoryMb >= 8192) deviceClass = "high";
    else if (memoryMb >= 4096) deviceClass = "mid";
    else deviceClass = "low";

    // Available runtimes
    const runtimes: string[] = ["wasm"];
    const hasGpu =
      typeof navigator !== "undefined" && "gpu" in navigator;
    if (hasGpu) runtimes.push("webgpu");

    // Storage via StorageManager
    let storageMb = 0;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.storage &&
        navigator.storage.estimate
      ) {
        const est = await navigator.storage.estimate();
        storageMb = Math.round((est.quota || 0) / (1024 * 1024));
      }
    } catch {
      // StorageManager unavailable — leave at 0.
    }

    // Accelerators
    const accelerators: string[] = [];
    if (hasGpu) accelerators.push("webgpu");

    return {
      deviceClass,
      availableRuntimes: runtimes,
      memoryMb,
      storageMb,
      platform: "browser",
      accelerators,
    };
  }
}
