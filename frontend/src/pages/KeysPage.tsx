import { useState } from 'react'
import { ApiError, api } from '../api'
import { useSession } from '../auth'
import { Button, Card, ErrorText, Field, Input, onSubmit } from '../ui'

export default function KeysPage() {
  const { session, setSession } = useSession()
  const [adminKey, setAdminKey] = useState(session.adminKey || 'dev-admin-key-change-me')
  const [name, setName] = useState('acme')
  const [freshKey, setFreshKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function createTenant() {
    setError(null)
    setBusy(true)
    try {
      const res = await api<{ apiKey: string; apiKeyLast4: string; name: string }>('/tenants', {
        method: 'POST',
        adminKey,
        body: JSON.stringify({ name, plan: 'PRO' }),
      })
      setFreshKey(res.apiKey)
      setSession({ adminKey, apiKey: res.apiKey, apiKeyLast4: res.apiKeyLast4, tenantName: res.name })
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function rotate() {
    setError(null)
    setBusy(true)
    try {
      const res = await api<{ apiKey: string; apiKeyLast4: string }>('/api-keys/rotate', {
        method: 'POST',
        apiKey: session.apiKey,
      })
      setFreshKey(res.apiKey)
      setSession({ apiKey: res.apiKey, apiKeyLast4: res.apiKeyLast4 })
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card title="테넌트 생성 — API 키는 이 화면에서만 원문이 보입니다">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={onSubmit(createTenant)}>
          <Field label="Admin 키">
            <Input value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
          </Field>
          <Field label="테넌트 이름">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              테넌트 만들기
            </Button>
          </div>
        </form>
        <ErrorText error={error} />
        {freshKey && (
          <p className="mt-4 break-all rounded-lg bg-amber-50 p-3 font-mono text-sm text-amber-900">
            {freshKey}
            <span className="mt-1 block font-sans text-xs text-amber-700">다시 볼 수 없습니다. 저장하세요. 회전 시 구 키는 24시간 유예됩니다.</span>
          </p>
        )}
      </Card>
      {session.apiKey && (
        <Card title="키 회전" actions={<Button onClick={() => void rotate()} disabled={busy}>회전</Button>}>
          <p className="text-sm text-slate-600">
            사용 중: <span className="font-mono">sk_live_…{session.apiKeyLast4}</span> · 테넌트 {session.tenantName || '—'}
          </p>
        </Card>
      )}
    </div>
  )
}
