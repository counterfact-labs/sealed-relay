export const untrustedContentCheckEnabled = (settings: Readonly<Record<string, string | undefined>>): boolean => settings.CF_UNTRUSTED_CONTENT_CHECK !== "0";
