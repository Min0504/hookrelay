import { useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../api'
import { useSession } from '../auth'
import { Button, Card, ErrorText, Field } from '../ui'

interface LogLine {
  kind: string
  deliveryId?: string
  eventId?: string
  type?: string
  at?: string
}

export default function LivePage() {
  const { session } = useSession()
  const [payload, setPayload] = useState('{"hello":"world"}')
  const [logs, setLogs] = useState<LogLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const es = new EventSource('/receiver/stream')
    es.onmessage = (ev) => {
      try {
        const line = JSON.parse(ev.data) as LogLine
        setLogs((prev) => [line, ...prev].slice(0, 80))
      } catch {
        /* ignore */
      }
    }
    return () => es.close()
  }, [])

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [logs])

  async function publish() {
    setError(null)
    try {
      JSON.parse(payload)
      await api('/events', {
        method: 'POST',
        apiKey: session.apiKey,
        headers: { 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'order.created', payload: JSON.parse(payload) as unknown }),
      })
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e))
    }
  }

  if (!session.apiKey) return <p className="text-sm text-slate-500">먼저 키 화면에서 테넌트를 만드세요.</p>

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="이벤트 발행">
        <Field label="payload JSON">
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={10}
            className="w-full rounded-lg border border-slate-300 p-3 font-mono text-xs"
          />
        </Field>
        <div className="mt-3">
          <Button onClick={() => void publish()}>발행 (202)</Button>
        </div>
        <ErrorText error={error} />
        <p className="mt-3 text-xs text-slate-400">
          왼쪽에서 발행하면 Relay가 큐에 올리고 워커가 HMAC 서명과 함께 demo-receiver로 POST합니다. 오른쪽은 SSE입니다.
        </p>
      </Card>
      <Card title="demo-receiver 수신 로그">
        <div ref={scroller} className="h-[28rem] overflow-auto font-mono text-xs">
          {logs.length === 0 && <p className="text-slate-400">대기 중 — endpoint를 demo-receiver /hooks 로 등록하세요.</p>}
          {logs.map((l, i) => (
            <div key={`${l.deliveryId ?? i}-${l.at}`} className="border-b border-slate-100 py-2">
              <span className="text-violet-600">{l.kind}</span> {l.type} {l.deliveryId}
              <div className="text-slate-400">{l.at}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
