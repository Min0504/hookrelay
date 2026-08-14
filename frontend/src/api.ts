export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export async function api<T>(path: string, init: RequestInit & { apiKey?: string; adminKey?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (init.apiKey) headers.set('Authorization', `Bearer ${init.apiKey}`)
  if (init.adminKey) headers.set('X-Admin-Key', init.adminKey)
  const res = await fetch(`/api${path}`, { ...init, headers })
  const body = await parse(res)
  if (!res.ok) {
    const err = body as { code?: string; message?: string } | null
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? res.statusText)
  }
  return body as T
}

export async function receiver<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/receiver${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  return (await parse(res)) as T
}
