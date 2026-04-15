/**
 * Browser environment helpers that stay safe in Node, SSR, and test runners.
 */

type NavigatorWithOptionalApis = Navigator & {
  deviceMemory?: number;
  getBattery?: () => Promise<{ level?: number; charging?: boolean }>;
};

function currentNavigator(): NavigatorWithOptionalApis | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : (navigator as NavigatorWithOptionalApis);
}

export async function getBatterySafely(): Promise<{
  level?: number;
  charging?: boolean;
} | null> {
  const nav = currentNavigator();
  if (!nav?.getBattery) {
    return null;
  }

  try {
    return await nav.getBattery();
  } catch {
    return null;
  }
}

export function getUserAgent(): string {
  return currentNavigator()?.userAgent ?? "unknown";
}

export function getLocale(): string | undefined {
  return currentNavigator()?.language;
}

export function getLocaleOrDefault(defaultLocale = "en"): string {
  return currentNavigator()?.language ?? defaultLocale;
}

export function getDeviceMemoryMb(): number | undefined {
  const memoryGb = currentNavigator()?.deviceMemory;
  return typeof memoryGb === "number" && Number.isFinite(memoryGb)
    ? Math.round(memoryGb * 1024)
    : undefined;
}

export function getTimezone(): string | undefined {
  try {
    return typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined;
  } catch {
    return undefined;
  }
}
