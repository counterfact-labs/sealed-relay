/** Hold connections while checking reservations, and model capacity only after the owner is verified. */
export function createCallAdmission(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("Invalid relay concurrency");
  const clientLimit = Math.max(1, Math.floor(limit / 2));
  const connections = new Set<string>();
  const clients = new Map<string, number>();
  let active = 0;
  return {
    connection(id: string): (() => void) | undefined {
      if (connections.has(id)) return;
      connections.add(id);
      return () => { connections.delete(id); };
    },
    client(id: string): (() => void) | undefined {
      const count = clients.get(id) ?? 0;
      if (active >= limit || count >= clientLimit) return;
      active++;
      clients.set(id, count + 1);
      return () => {
        active--;
        const remaining = clients.get(id)! - 1;
        if (remaining) clients.set(id, remaining);
        else clients.delete(id);
      };
    },
  };
}
