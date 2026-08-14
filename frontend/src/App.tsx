import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useSession } from './auth'
import DeliveriesPage from './pages/DeliveriesPage'
import DlqPage from './pages/DlqPage'
import EndpointsPage from './pages/EndpointsPage'
import KeysPage from './pages/KeysPage'
import LivePage from './pages/LivePage'

const NAV = [
  { to: '/', label: '키' },
  { to: '/endpoints', label: 'Endpoints' },
  { to: '/deliveries', label: '배달 이력' },
  { to: '/dlq', label: 'DLQ' },
  { to: '/live', label: '라이브 데모' },
]

export default function App() {
  const { session, clear } = useSession()
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-8">
            <h1 className="text-lg font-bold tracking-tight">
              Hook<span className="text-violet-600">Relay</span>
              <span className="ml-2 text-xs font-medium text-slate-400">CONSOLE</span>
            </h1>
            <nav className="flex gap-1">
              {NAV.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                    }`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            {session.apiKeyLast4 && <span>sk_live_…{session.apiKeyLast4}</span>}
            {session.apiKey && (
              <button onClick={clear} className="text-slate-400 underline-offset-2 hover:underline">
                세션 지우기
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Routes>
          <Route path="/" element={<KeysPage />} />
          <Route path="/endpoints" element={<EndpointsPage />} />
          <Route path="/deliveries" element={<DeliveriesPage />} />
          <Route path="/dlq" element={<DlqPage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
