// Target and preserved rollback hardware are chosen only here, and callers never accept both together; rollback keeps AMD SEV on its original machine.
const target = Object.freeze({ hwmodel: "GCP_INTEL_TDX", computeType: "TDX", machine: "c3-standard-4",
  confidentialImage: "projects/confidential-space-images/global/images/confidential-space-260800" } as const);
const rollback = Object.freeze({ hwmodel: "GCP_AMD_SEV", computeType: "SEV", machine: "n2d-standard-2",
  confidentialImage: target.confidentialImage } as const);
export type HardwareProfile = "target" | "rollback";
export const hardwareModels = [target.hwmodel, rollback.hwmodel] as const;

export function confidentialHardware(profile: HardwareProfile = "rollback") {
  if (profile === "target") return target;
  if (profile === "rollback") return rollback;
  throw new Error("Invalid confidential hardware policy");
}

export function isApprovedHardware(model: string, approved: readonly string[]): boolean {
  return approved.length === 1 && hardwareModels.some(value => value === model) && approved[0] === model;
}

export function requireSealedRootHardware(config: { hardwareProfile?: HardwareProfile; confidentialImage: string },
  policy?: { hardwareModels: readonly string[] }): void {
  if (config.hardwareProfile !== "target" || config.confidentialImage !== target.confidentialImage ||
    policy && !isApprovedHardware(target.hwmodel, policy.hardwareModels))
    throw new Error("Sealed root requires reviewed target hardware and host image");
}
