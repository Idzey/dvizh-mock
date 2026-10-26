export const newId = (): string => crypto.randomUUID();
export const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
