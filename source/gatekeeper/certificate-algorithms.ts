export type CertificateAlgorithms = {
  keyType?: string;
  modulusLength?: number;
  namedCurve?: string;
  signatureAlgorithm: string;
  pssHashAlgorithm?: string;
};

export const RSA_PSS_SIGNATURE_ALGORITHM = "1.2.840.113549.1.1.10";
const curves = new Set(["prime256v1", "secp384r1", "secp521r1"]);
const signatures = new Set([
  "1.2.840.113549.1.1.11", "1.2.840.113549.1.1.12", "1.2.840.113549.1.1.13",
  "1.2.840.10045.4.3.2", "1.2.840.10045.4.3.3", "1.2.840.10045.4.3.4",
  "1.3.101.112", "1.3.101.113",
]);
const pssHashes = new Set(["2.16.840.1.101.3.4.2.1", "2.16.840.1.101.3.4.2.2", "2.16.840.1.101.3.4.2.3"]);

/** WebCrypto can verify obsolete algorithms; accepting a signature also requires a local strength policy. */
export function hasStrongCertificateAlgorithms(algorithms: CertificateAlgorithms): boolean {
  const { keyType, modulusLength, namedCurve, signatureAlgorithm, pssHashAlgorithm } = algorithms;
  const strongKey = keyType === "rsa" || keyType === "rsa-pss" ? (modulusLength ?? 0) >= 2048
    : keyType === "ec" ? curves.has(namedCurve ?? "") : keyType === "ed25519" || keyType === "ed448";
  if (!strongKey) return false;
  return signatureAlgorithm === RSA_PSS_SIGNATURE_ALGORITHM
    ? pssHashes.has(pssHashAlgorithm ?? "") : signatures.has(signatureAlgorithm);
}
