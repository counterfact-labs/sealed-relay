import type { Tool } from "../scripts/relay/cloud-tools.ts";

type StsRefusal = "attribute-condition" | "other";

export function stsExchangeBody(audience: string, subjectToken: string) {
  return {
    audience, grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt", subject_token: subjectToken,
    scope: "https://www.googleapis.com/auth/cloud-platform",
  };
}

export function classifyStsRefusal(httpStatus: number, body: string): StsRefusal {
  if (httpStatus !== 400 && httpStatus !== 403) return "other";
  try {
    const response = JSON.parse(body);
    // Exact wording keeps token failures from masquerading as policy evidence.
    if (response && !Array.isArray(response) && response.error === "unauthorized_client" &&
      response.error_description === "The given credential is rejected by the attribute condition." &&
      !("access_token" in response)) return "attribute-condition";
  } catch { /* Malformed responses cannot prove a policy refusal. */ }
  return "other";
}

export function exchangeWithCurl(run: Tool, audience: string, subjectToken: string): { status: number; refusal: StsRefusal } {
  try {
    const response = run("curl", ["--disable", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", "--max-time", "30",
      "--request", "POST", "--header", "Content-Type: application/json", "--data-binary", "@-", "--write-out", "\n%{http_code}",
      "https://sts.googleapis.com/v1/token"], Buffer.from(JSON.stringify(stsExchangeBody(audience, subjectToken)))).toString("utf8");
    // Only curl's final status trailer is framing; the private body never leaves this function.
    const trailer = /\n([1-5][0-9]{2})$/.exec(response);
    if (!trailer) throw new Error();
    const status = Number(trailer[1]);
    return { status, refusal: classifyStsRefusal(status, response.slice(0, trailer.index)) };
  } catch { throw new Error("STS exchange failed"); }
}
