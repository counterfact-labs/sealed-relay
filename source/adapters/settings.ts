import { snapshotSettings, type JobSettings } from "@counterfact-labs/analysis-core/settings";
export type { JobSettings } from "@counterfact-labs/analysis-core/settings";

// A run keeps its supplied switches even if the process environment later changes.
export function readJobSettings(env: JobSettings = process.env): JobSettings {
  return snapshotSettings(env);
}

export function readTransportSettings(env: JobSettings = process.env) {
  return Object.freeze({ CF_LOCAL_RELAY: env.CF_LOCAL_RELAY, CF_RELAY_DEV: env.CF_RELAY_DEV, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ...Object.fromEntries(["CF_RELAY_URL", "CF_CONSOLE_URL", "CF_CONSOLE_TOKEN", "CF_RELAY_DEV_TRUST", "CF_RELAY_DEV_BUNDLE", "CF_RELAY_DEV_RELEASE"].filter(key => env[key] !== undefined).map(key => [key, env[key]])) }) as
    Readonly<{ CF_LOCAL_RELAY?: string; CF_RELAY_DEV?: string; ANTHROPIC_API_KEY?: string; CF_RELAY_URL?: string;
      CF_CONSOLE_URL?: string; CF_CONSOLE_TOKEN?: string;
      CF_RELAY_DEV_TRUST?: string; CF_RELAY_DEV_BUNDLE?: string; CF_RELAY_DEV_RELEASE?: string }>;
}

export type TransportSettings = Readonly<Partial<ReturnType<typeof readTransportSettings>>>;

/** Only creation fills defaults; continuation consumes its saved snapshot unchanged. */
export function newRunSettings(caller?: JobSettings, env: JobSettings = process.env): JobSettings {
  const choice = caller?.CF_FINDING_HEADLINES || env.CF_FINDING_HEADLINES || "0";
  if (choice !== "0" && choice !== "1") throw new Error("CF_FINDING_HEADLINES must be 0 or 1.");
  const outside = caller?.CF_IMPORT_OUTSIDE_LOADERS || env.CF_IMPORT_OUTSIDE_LOADERS || "0";
  return snapshotSettings({ ...(caller ?? env), CF_FINDING_HEADLINES: choice, CF_IMPORT_OUTSIDE_LOADERS: outside });
}

/** The installed command selects the relay; source-only switches remain on the development runner. */
export function readCliSettings(env: JobSettings = process.env, emailSignIn?: boolean) {
  return Object.freeze({ settings: newRunSettings(undefined, env), transport: readTransportSettings(env),
    baseUrl: env.COUNTERFACT_URL ?? env.CF_CONSOLE_URL, emailSignIn: emailSignIn ?? readEmailSignIn(env) });
}
export type CliSettings = ReturnType<typeof readCliSettings>;

export function readEmailSignIn(env: JobSettings = process.env): boolean {
  return env.CF_EMAIL_SIGN_IN !== "0";
}
