import type { FormEvent, InputHTMLAttributes, ReactNode } from 'react'

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-700">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  const styles = {
    primary: 'bg-slate-900 text-white hover:bg-slate-700',
    ghost: 'border border-slate-300 text-slate-700 hover:bg-slate-50',
    danger: 'bg-rose-600 text-white hover:bg-rose-500',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${styles[variant]}`}
    >
      {children}
    </button>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-500">{label}</span>
      {children}
    </label>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 ${props.className ?? ''}`}
    />
  )
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null
  return <p className="mt-2 text-sm text-rose-600">{error}</p>
}

export function Badge({ children, tone }: { children: ReactNode; tone: 'green' | 'red' | 'amber' | 'slate' | 'violet' }) {
  const map = {
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    red: 'bg-rose-50 text-rose-700 ring-rose-200',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200',
    slate: 'bg-slate-50 text-slate-600 ring-slate-200',
    violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  }
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${map[tone]}`}>{children}</span>
}

export function onSubmit(fn: () => Promise<void>) {
  return (e: FormEvent) => {
    e.preventDefault()
    void fn()
  }
}

export function statusTone(status: string): 'green' | 'red' | 'amber' | 'slate' | 'violet' {
  if (status === 'SUCCEEDED' || status === 'ACTIVE') return 'green'
  if (status === 'DEAD' || status === 'DISABLED_AUTO') return 'red'
  if (status === 'FAILED_RETRYING' || status === 'PENDING') return 'amber'
  return 'slate'
}
