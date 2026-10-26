import { filterAnalysisSettings } from "./contracts/requests";

export type CoreSettings = Readonly<Record<string, string | undefined>>;
export type JobSettings = CoreSettings;

export function findingHeadlinesEnabled(settings: CoreSettings): boolean {
  return settings.CF_FINDING_HEADLINES === "1";
}

export function outsideLoadersEnabled(settings: JobSettings): boolean {
  return settings.CF_IMPORT_OUTSIDE_LOADERS === "1";
}

// Keep the recorded detector requests until the revised rules have benchmark evidence.
export function promptAgreementEnabled(settings: CoreSettings): boolean {
  return settings.CF_PROMPT_AGREE === "1";
}

// Filtering is shared; only the product decides when to read its environment.
export function snapshotSettings(env: CoreSettings): CoreSettings {
  return filterAnalysisSettings(env, "saved");
}
