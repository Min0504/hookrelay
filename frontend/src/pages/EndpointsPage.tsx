import { useEffect, useState } from 'react'
import { ApiError, api, receiver } from '../api'
import { useSession } from '../auth'
import { Badge, Button, Card, ErrorText, Field, Input, onSubmit, statusTone } from '../ui'

interface Endpoint {
  id: string
  url: string
  status: string
  eventTypes?: string[]
  consecutiveFailures?: number
  secret?: string
}

export default function EndpointsPage() {
  const { session, setSession } = useSession()
  const [rows, setRows] = useState<Endpoint[]>([])
  const [url, setUrl] = useState('http://demo-receiver:4100/hooks')
  const [types, setTypes] = useState('order.created')
  const [error, setError] = useState<string | null>(null)
  const [freshSecret, setFreshSecret] = useState<string | null>(null)

  async function load() {
    if (!session.apiKey) return
    const list = await api<Endpoint[]>('/endpoints', { apiKey: session.apiKey })
    setRows(list)
  }

  useEffect(() => {
    void load().catch((e: unknown) => setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)))
  }, [session.apiKey])

  async function create() {
    setError(null)
    try {
      const created = await api<Endpoint>('/endpoints', {
        method: 'POST',
        apiKey: session.apiKey,
        body: JSON.stringify({ url }),
      })
      if (created.secret) {
        setFreshSecret(created.secret)
        setSession({ endpointSecret: created.secret })
        await receiver('/config', { method: 'POST', body: JSON.stringify({ secret: created.secret }) })
      }
      await api(`/endpoints/${created.id}/subscriptions`, {
        method: 'PUT',
        apiKey: session.apiKey,
        body: JSON.stringify({ eventTypes: types.split(',').map((s) => s.trim()).filter(Boolean) }),
      })
      await load()
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e))
    }
  }

  async function ping(id: string) {
    setError(null)
    try {
      await api(`/endpoints/${id}/ping`, { method: 'POST', apiKey: session.apiKey })
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e))
    }
  }

  if (!session.apiKey) return <p className="text-sm text-slate-500">먼저 키 화면에서 테넌트를 만드세요.</p>

  return (
    <div className="space-y-4">
      <Card title="Endpoint 등록 — 사설 IP/메타데이터 URL은 SSRF로 거절됩니다">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={onSubmit(create)}>
          <Field label="수신 URL">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="구독 타입 (콤마)">
            <Input value={types} onChange={(e) => setTypes(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit">등록</Button>
          </div>
        </form>
        <ErrorText error={error} />
        {freshSecret && (
          <p className="mt-3 break-all rounded-lg bg-amber-50 p-3 font-mono text-xs text-amber-900">
            HMAC secret (1회): {freshSecret}
          </p>
        )}
      </Card>
      <Card title="등록된 endpoint">
        <ul className="divide-y divide-slate-100 text-sm">
          {rows.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-3">
              <div>
                <p className="font-mono text-xs text-slate-700">{e.url}</p>
                <p className="mt-1 text-xs text-slate-400">{(e.eventTypes ?? []).join(', ') || '구독 없음'}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                <Button variant="ghost" onClick={() => void ping(e.id)}>
                  ping
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
