// src/renderer/components/optical-view/context-meter.tsx
import React from 'react'
import type { SessionMeta } from '../../lib/use-claude-stream'

function modelBudget(model?: string): number {
  if (!model) return 200_000
  // Haiku/Sonnet run the standard window; larger models on plans with the
  // extended window run 1M context (the model id carries no [1m] marker).
  if (model.includes('haiku') || model.includes('sonnet')) return 200_000
  return 1_000_000
}

export function ContextMeter({ meta }: { meta: SessionMeta }) {
  const used = meta.totalTokens ?? 0
  if (used === 0) return null
  const max = modelBudget(meta.model)
  const pct = Math.min(100, (used / max) * 100)
  const fillClass = pct < 85 ? 'bg-purple-1' : 'bg-red-1'
  const maxLabel = max >= 1_000_000 ? '1M' : `${Math.round(max / 1000)}k`
  return (
    <div
      className="flex items-center gap-2"
      title={`Context window: ${used.toLocaleString()} of ${max.toLocaleString()} tokens used`}
    >
      <div className="w-16 h-1 rounded-full bg-[color:var(--color-hairline)] overflow-hidden">
        <div className={`h-full ${fillClass} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-text-3">
        {(used / 1000).toFixed(0)}k / {maxLabel} · {pct.toFixed(0)}%
      </span>
    </div>
  )
}
