import { z } from "zod";

export const hash = z.string().regex(/^[0-9a-f]{64}$/);
