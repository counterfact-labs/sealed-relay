// The pinned distroless base image sets SSL_CERT_FILE to its bundled certificates. The relay accepts exactly that
// value, so the image works while no operator setting can point the relay at a different trust store.
export const BASE_CERTIFICATE_FILE = "/etc/ssl/certs/ca-certificates.crt";
const fixedValues: Readonly<Record<string, string>> = Object.freeze({ SSL_CERT_FILE: BASE_CERTIFICATE_FILE });

// Native startup consumes these data, so loader checks have the same owner as runtime checks.
export const runtimeEnvironmentPolicy = Object.freeze({
  fixedValues,
  forbiddenPrefixes: ["CF_RELAY_", "ANTHROPIC_", "GOOGLE_AUTH_", "LD_"],
  forbiddenNames: ["GOOGLE_APPLICATION_CREDENTIALS", "NODE_OPTIONS", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_DIR", "GLIBC_TUNABLES", "GCONV_PATH"],
  forbiddenNamesIgnoringCase: ["http_proxy", "https_proxy", "all_proxy"],
});

export const reviewedNativeImageEnvironment = Object.freeze([
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  `SSL_CERT_FILE=${BASE_CERTIFICATE_FILE}`, "NODE_ENV=production", "TMPDIR=/tmp",
]);

/** Refuses settings that could redirect credentials, trust or traffic; the image checker reads the same fixed values. */
export function checkRuntimeEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (fixedValues[name] !== undefined) {
      if (value !== fixedValues[name]) throw new Error();
      continue;
    }
    if (runtimeEnvironmentPolicy.forbiddenPrefixes.some(prefix => name.startsWith(prefix)) ||
      runtimeEnvironmentPolicy.forbiddenNamesIgnoringCase.includes(name.toLowerCase()) ||
      runtimeEnvironmentPolicy.forbiddenNames.includes(name)) throw new Error();
  }
}

/** True when an image configuration Env entry pins one of the fixed values the runtime accepts. */
export function isFixedImageEnvironment(entry: string): boolean {
  return Object.entries(fixedValues).some(([name, value]) => entry === `${name}=${value}`);
}
