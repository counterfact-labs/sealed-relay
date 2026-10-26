import { z } from "zod";

/** Release and workload credentials share the same byte policy before entering HTTP headers or SDKs. */
export const credential = z.string().min(1).max(16384).refine(value => !/[^\x21-\x7e]/.test(value));
