import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { BitString, fromBER, Integer, Utf8String } from "asn1js";
import { AlgorithmIdentifier, AttributeTypeAndValue, BasicConstraints, Certificate, Extension,
  PublicKeyInfo, RelativeDistinguishedNames, Time } from "pkijs";

/** Only the workload creates this key. The provisional leaf is authenticated by channel evidence, not a web CA. */
export function generateTlsCredentials(): { key: string; cert: string } {
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    // A positive random serial prevents reuse across process starts without persisting identity.
    const serial = randomBytes(16);
    serial[0] = (serial[0] & 0x7f) | 0x01;
    const name = new RelativeDistinguishedNames({ typesAndValues: [new AttributeTypeAndValue({
      type: "2.5.4.3", value: new Utf8String({ value: "relay.invalid" }),
    })] });
    const algorithm = new AlgorithmIdentifier({ algorithmId: "1.2.840.10045.4.3.2" });
    const now = Math.floor(Date.now() / 1000) * 1000;
    const certificate = new Certificate({ version: 2, serialNumber: new Integer({ valueHex: new Uint8Array(serial).buffer }),
      issuer: name, subject: name, signature: algorithm, signatureAlgorithm: algorithm,
      notBefore: new Time({ value: new Date(now) }), notAfter: new Time({ value: new Date(now + 24 * 60 * 60 * 1000) }),
      subjectPublicKeyInfo: new PublicKeyInfo({ schema: fromBER(publicKey.export({ type: "spki", format: "der" })).result }),
      extensions: [
        new Extension({ extnID: "2.5.29.19", critical: true, extnValue: new BasicConstraints({ cA: false }).toSchema().toBER(false) }),
        new Extension({ extnID: "2.5.29.15", critical: true,
          extnValue: new BitString({ unusedBits: 7, valueHex: new Uint8Array([0x80]).buffer }).toBER(false) }),
      ],
    });
    // Node signs synchronously; PKIjs only encodes the certificate and its signed body.
    certificate.tbsView = new Uint8Array(certificate.encodeTBS().toBER(false));
    certificate.signatureValue = new BitString({ valueHex: new Uint8Array(sign("sha256", certificate.tbsView, privateKey)).buffer });
    const encoded = Buffer.from(certificate.toSchema().toBER(false)).toString("base64");
    const cert = `-----BEGIN CERTIFICATE-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
    const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const leaf = new X509Certificate(cert);
    if (!leaf.checkPrivateKey(createPrivateKey(key)) || !leaf.verify(leaf.publicKey)) throw new Error();
    return { key, cert };
  } catch {
    throw new Error("Cannot generate workload TLS credentials");
  }
}
