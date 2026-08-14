import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

export interface Session {
  adminKey: string
  apiKey: string
  apiKeyLast4: string
  tenantName: string
  endpointSecret: string
}

const empty: Session = { adminKey: '', apiKey: '', apiKeyLast4: '', tenantName: '', endpointSecret: '' }

const Ctx = createContext<{
  session: Session
  setSession: (patch: Partial<Session>) => void
  clear: () => void
} | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, set] = useState<Session>(() => {
    const raw = localStorage.getItem('hr.session')
    return raw ? ({ ...empty, ...(JSON.parse(raw) as Session) } as Session) : empty
  })
  const value = useMemo(
    () => ({
      session,
      setSession: (patch: Partial<Session>) => {
        set((prev) => {
          const next = { ...prev, ...patch }
          localStorage.setItem('hr.session', JSON.stringify(next))
          return next
        })
      },
      clear: () => {
        localStorage.removeItem('hr.session')
        set(empty)
      },
    }),
    [session],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('AuthProvider missing')
  return ctx
}
