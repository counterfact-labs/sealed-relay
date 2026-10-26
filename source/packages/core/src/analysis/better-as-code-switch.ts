import type { JobSettings } from "../settings";
export function betterAsCodeEnabled(settings: JobSettings): boolean {
  return settings.CF_FINDING_BETTER_AS_CODE === "1";
}
