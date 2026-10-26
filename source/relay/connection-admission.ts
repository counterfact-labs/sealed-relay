const maxConnectionsPerAddress = 16;
const maxAttestationsPerAddress = 32;
const attestationWindowMs = 60_000;
const maxAddresses = 4096;
type AddressState = { connections: number; attestations: number; resetAt: number };

/** Socket addresses, never caller-supplied forwarding headers, own these budgets. */
export function createConnectionAdmission(now: () => number = Date.now) {
  const addresses = new Map<string, AddressState>();
  function stateFor(address: string | undefined) {
    if (!address) return;
    const timestamp = now();
    for (const [key, state] of addresses) {
      if (!state.connections && state.resetAt <= timestamp) addresses.delete(key);
    }
    let state = addresses.get(address);
    if (!state) {
      if (addresses.size >= maxAddresses) return;
      state = { connections: 0, attestations: 0, resetAt: timestamp + attestationWindowMs };
      addresses.set(address, state);
    } else if (state.resetAt <= timestamp) {
      state.attestations = 0;
      state.resetAt = timestamp + attestationWindowMs;
    }
    return state;
  }
  return {
    open(address: string | undefined): (() => void) | undefined {
      const state = stateFor(address);
      if (!state || state.connections >= maxConnectionsPerAddress) return;
      state.connections++;
      let released = false;
      return () => { if (!released) { state.connections--; released = true; } };
    },
    attest(address: string | undefined): boolean {
      const state = stateFor(address);
      if (!state || state.attestations >= maxAttestationsPerAddress) return false;
      state.attestations++;
      return true;
    },
  };
}
