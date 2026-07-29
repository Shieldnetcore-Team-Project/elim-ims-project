export async function api<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const qs = params
    ? '?' + Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&')
    : '';
  const res = await fetch(`/api${path}${qs && qs !== '?' ? qs : ''}`);
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(payload?.error ?? `API ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const apiPost = <T>(path: string, body: unknown) => send<T>('POST', path, body);
export const apiPut = <T>(path: string, body: unknown) => send<T>('PUT', path, body);
