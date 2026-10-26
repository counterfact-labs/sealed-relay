import { resolve } from "node:path";
import { z } from "zod";
import { reviewedReference } from "../../gatekeeper/trust/release";
import { hashBytes, regularFile } from "./command";

export const reference = reviewedReference;
export type Reference = z.infer<typeof reference>;

export async function readReviewed(ref: Reference): Promise<Buffer> {
  reference.parse(ref);
  const bytes = await regularFile(resolve(ref.path));
  if (hashBytes(bytes) !== ref.sha256) throw new Error("Reviewed file changed");
  return bytes;
}
