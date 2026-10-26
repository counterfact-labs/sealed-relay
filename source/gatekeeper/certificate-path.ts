import { X509Certificate, webcrypto, type KeyObject } from "node:crypto";
import { BitString, fromBER } from "asn1js";
import { BasicConstraints, Certificate, CertificateChainValidationEngine, CryptoEngine, ExtensionValueFactory, RSASSAPSSParams, type CryptoEngineParameters } from "pkijs";
import { AttestationError } from "./attestation.ts";
import { hasStrongCertificateAlgorithms, RSA_PSS_SIGNATURE_ALGORITHM } from "./certificate-algorithms.ts";

const crypto = new CryptoEngine({ name: "node", crypto: webcrypto as unknown as CryptoEngineParameters["crypto"],
  subtle: webcrypto.subtle as unknown as CryptoEngineParameters["subtle"] });

function parseCertificate(cert: X509Certificate): Certificate {
  const bytes = Uint8Array.from(cert.raw);
  const decoded = fromBER(bytes.buffer);
  if (decoded.offset !== bytes.length) throw new Error();
  return new Certificate({ schema: decoded.result });
}

function checkPathConstraints(path: readonly Certificate[]): void {
  let intermediateCount = 0;
  for (const [index, cert] of path.entries()) {
    for (const extension of cert.extensions ?? []) {
      if (!extension.critical) continue;
      // PKIjs also parses unknown extensions as generic ASN.1; parsing alone does not establish recognition.
      // Subject key identifier, key usage and inhibit-any-policy use primitive ASN.1 rather than registered classes.
      const recognized = ExtensionValueFactory.find(extension.extnID) || ["2.5.29.14", "2.5.29.15", "2.5.29.54"].includes(extension.extnID);
      const value = extension.parsedValue;
      if (!recognized || !value || "parsingError" in value) throw new Error();
    }
    // PKIjs does not enforce pathLenConstraint. Count only non-self-issued CAs below each issuer, never the leaf.
    const constraints = cert.extensions?.find(extension => extension.extnID === "2.5.29.19")?.parsedValue;
    if (constraints instanceof BasicConstraints && constraints.pathLenConstraint !== undefined) {
      const limit = constraints.pathLenConstraint;
      if (intermediateCount > (typeof limit === "number" ? limit : limit.toBigInt())) throw new Error();
    }
    if (index > 0 && !cert.subject.isEqual(cert.issuer)) intermediateCount++;
  }
}

/** PKIjs owns path validation; only shipped roots are trusted, with no network or system CA discovery. */
export async function validateCertificatePath(chain: readonly X509Certificate[], roots: readonly string[], now: number): Promise<KeyObject> {
  try {
    if (!Number.isSafeInteger(now) || chain.length < 1 || chain.length > 5 || !roots.length || roots.length > 8) throw new Error();
    // Reviewed root rotations can overlap; an unused expired anchor must not invalidate a different valid path.
    const current = (cert: X509Certificate) => now * 1000 >= Date.parse(cert.validFrom) && now * 1000 < Date.parse(cert.validTo);
    const anchors = roots.map(root => new X509Certificate(root)).filter(root => root.ca && current(root));
    if (!anchors.length || chain.some(cert => !current(cert))) throw new Error();
    const [leaf] = chain;
    if (leaf.ca || leaf.publicKey.asymmetricKeyType !== "rsa") throw new Error();
    // Path builders may discard extraneous certificates; the wire format requires one ordered, connected path.
    if (new Set(chain.map(cert => cert.fingerprint256)).size !== chain.length) throw new Error();
    for (let index = 1; index < chain.length; index++) {
      if (!chain[index].ca || !chain[index - 1].checkIssued(chain[index])) throw new Error();
    }
    const isAnchor = (cert: X509Certificate) => anchors.some(root => root.fingerprint256 === cert.fingerprint256);
    const last = chain.at(-1)!;
    if (last.checkIssued(last) && !isAnchor(last)) throw new Error();
    const supplied = chain.map(cert => ({ cert, parsed: parseCertificate(cert) }));
    const trusted = anchors.map(cert => ({ cert, parsed: parseCertificate(cert) }));
    for (const { cert, parsed } of [...supplied, ...trusted]) {
      const key = cert.publicKey;
      const signature = parsed.signatureAlgorithm;
      const pssHashAlgorithm = signature.algorithmId === RSA_PSS_SIGNATURE_ALGORITHM && signature.algorithmParams
        ? new RSASSAPSSParams({ schema: signature.algorithmParams }).hashAlgorithm.algorithmId : undefined;
      if (!hasStrongCertificateAlgorithms({ keyType: key.asymmetricKeyType,
        modulusLength: key.asymmetricKeyDetails?.modulusLength, namedCurve: key.asymmetricKeyDetails?.namedCurve,
        signatureAlgorithm: signature.algorithmId, pssHashAlgorithm })) throw new Error();
    }
    // RFC 5280: a leaf without a key usage extension is unrestricted, and Google's Confidential Space leaves omit it.
    // When the extension is present it must still allow digital signatures.
    const usageExtension = supplied[0].parsed.extensions?.find((extension: { extnID: string }) => extension.extnID === "2.5.29.15");
    if (usageExtension) {
      const usage = usageExtension.parsedValue;
      if (!(usage instanceof BitString) || !(usage.valueBlock.valueHexView[0] & 0x80)) throw new Error();
    }
    const validator = new CertificateChainValidationEngine({
      trustedCerts: trusted.map(({ parsed }) => parsed),
      // PKIjs takes the target certificate last, independently of the wire's leaf-first order.
      certs: supplied.filter(({ cert }) => !isAnchor(cert)).reverse().map(({ parsed }) => parsed),
      checkDate: new Date(now * 1000),
    });
    const result = await validator.verify({}, crypto);
    if (!result.result || !result.certificatePath) throw new Error();
    checkPathConstraints(result.certificatePath);
    return leaf.publicKey;
  } catch {
    // Certificate and dependency diagnostics can contain token material; retain only the fixed category.
    throw new AttestationError("Invalid production attestation certificate path");
  }
}
