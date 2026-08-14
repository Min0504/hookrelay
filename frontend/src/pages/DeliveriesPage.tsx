import { useEffect, useState } from 'react'
import { ApiError, api } from '../api'
import { useSession } from '../auth'
import { Badge, Button, Card, ErrorText, statusTone } from '../ui'

interface Delivery {
  deliveryId: string
  endpointUrl: string
  eventType: string
  status: string
  attemptCount: number
  createdAt: string
}

interface Attempt {
  attemptNo: number
  responseStatus: number | null
  errorClass: string | null
  durationMs: number | null
  attemptedAt: string
  responseBodyHead: string | null
}

export default function DeliveriesPage() {
  const { session } = useSession()
  const [rows, setRows] = useState<Delivery[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const res = await api<{ deliveries: Delivery[] }>('/deliveries', { apiKey: session.apiKey })
    setRows(res.deliveries)
  }

  useEffect(() => {
    if (!session.apiKey) return
    void load().catch((e: unknown) => setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)))
  }, [session.apiKey])

  async function expand(id: string) {
    if (open === id) {
      setOpen(null)
      return
    }
    const res = await api<{ attempts: Attempt[] }>(`/deliveries/${id}/attempts`, { apiKey: session.apiKey })
    setAttempts(res.attempts)
    setOpen(id)
  }

  if (!session.apiKey) return <p className="text-sm text-slate-500">먼저 키 화면에서 테넌트를 만드세요.</p>

  return (
    <Card title="배달 이력" actions={<Button variant="ghost" onClick={() => void load()}>새로고침</Button>}>
      <ErrorText error={error} />
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="py-2">상태</th>
            <th>타입</th>
            <th>시도</th>
            <th>URL</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((d) => (
            <tr key={d.deliveryId}>
              <td className="py-2">
                <Badge tone={statusTone(d.status)}>{d.status}</Badge>
              </td>
              <td className="font-mono text-xs">{d.eventType}</td>
              <td>{d.attemptCount}</td>
              <td className="max-w-xs truncate font-mono text-xs text-slate-500">{d.endpointUrl}</td>
              <td>
                <Button variant="ghost" onClick={() => void expand(d.deliveryId)}>
                  시도
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <ol className="mt-4 space-y-2 rounded-lg bg-slate-50 p-3 text-xs">
          {attempts.map((a) => (
            <li key={a.attemptNo}>
              #{a.attemptNo} {a.errorClass ?? a.responseStatus} · {a.durationMs ?? 0}ms · {a.attemptedAt}
              {a.responseBodyHead && <span className="ml-2 text-slate-400">{a.responseBodyHead.slice(0, 80)}</span>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}
