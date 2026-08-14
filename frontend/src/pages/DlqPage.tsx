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
}

export default function DlqPage() {
  const { session } = useSession()
  const [rows, setRows] = useState<Delivery[]>([])
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const res = await api<{ deliveries: Delivery[] }>('/deliveries?status=DEAD', { apiKey: session.apiKey })
    setRows(res.deliveries)
  }

  useEffect(() => {
    if (!session.apiKey) return
    void load().catch((e: unknown) => setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)))
  }, [session.apiKey])

  async function redeliver(id: string) {
    setError(null)
    try {
      await api(`/deliveries/${id}/redeliver`, { method: 'POST', apiKey: session.apiKey })
      await load()
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e))
    }
  }

  if (!session.apiKey) return <p className="text-sm text-slate-500">먼저 키 화면에서 테넌트를 만드세요.</p>

  return (
    <Card title="DLQ — DEAD 배달을 같은 X-Delivery-Id로 다시 보냅니다">
      <ErrorText error={error} />
      <ul className="divide-y divide-slate-100 text-sm">
        {rows.length === 0 && <li className="py-6 text-slate-400">비어 있습니다.</li>}
        {rows.map((d) => (
          <li key={d.deliveryId} className="flex items-center justify-between py-3">
            <div>
              <Badge tone={statusTone(d.status)}>{d.status}</Badge>
              <span className="ml-2 font-mono text-xs">{d.eventType}</span>
              <p className="mt-1 font-mono text-xs text-slate-400">{d.deliveryId}</p>
            </div>
            <Button onClick={() => void redeliver(d.deliveryId)}>재배달</Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
