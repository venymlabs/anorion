import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { RotateCw, Pause } from 'lucide-react'
import type { AgentSummary } from '@/api/types'
import { useNavigate } from 'react-router-dom'

interface Props {
  agent: AgentSummary
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function AgentCard({ agent }: Props) {
  const navigate = useNavigate()
  const budgetPct = agent.tokensToday > 0 ? Math.min(100, Math.round((agent.tokensToday / 200000) * 100)) : 0

  return (
    <Card className="cursor-pointer transition-colors hover:border-primary/50" onClick={() => navigate(`/agents/${agent.id}`)}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-sm">{agent.name}</h3>
              <StatusBadge status={agent.status} />
            </div>
            <p className="text-xs text-muted-foreground mt-1">{agent.model}</p>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation() }} title="Restart">
              <RotateCw className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation() }} title="Pause">
              <Pause className="h-3 w-3" />
            </Button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div>Sessions: <span className="text-foreground">{agent.activeSessions} active</span></div>
          <div>Tokens: <span className="text-foreground">{(agent.tokensToday / 1000).toFixed(0)}K/d</span></div>
          <div>Last: <span className="text-foreground">{timeAgo(agent.lastActive)}</span></div>
          {agent.tags?.map(t => <Badge key={t} variant="secondary" className="h-4 text-[10px]">{t}</Badge>)}
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
            <span>Token budget</span>
            <span>{budgetPct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full transition-all ${budgetPct > 80 ? 'bg-red-500' : budgetPct > 50 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${budgetPct}%` }} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
