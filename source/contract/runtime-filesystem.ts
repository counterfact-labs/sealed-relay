import { z } from "zod";

// Startup and release readiness accept the same workload-measured facts.
export const filesystemEvidence = z.object({ readOnlyRootFilesystem: z.literal(true), tmpFilesystemType: z.literal("tmpfs") }).strict();
