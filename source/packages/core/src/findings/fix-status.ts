import { z } from "zod";
/** Saved fix statuses also drive browser labels, without loading database tables. */
export const fixStatusSchema = z.enum(["ready", "needs_review", "blocked"]);
