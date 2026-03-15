import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AgentCard } from '@/components/AgentCard'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Activity, Server, Bot, Zap, AlertTriangle } from 'lucide-react'
import { mockAgents, mockActivity, mockGatewayStatus } from '@/lib/mock-data'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  return `${d}d ${h}h`
}

function eventIcon(type: string) {
  switch (type) {
    case 'message': return '🤖'
    case 'tool_call': return '🔧'
    case 'error': return '⚠️'
    case 'cron': return '⏰'
    case 'spawn': return '👶'
    case 'status_change': return '🔄'
    default: return '📌'
  }
}

function timeStr(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

const chartData = [
  { day: 'Mon', tokens: 320 },
  { day: 'Tue', tokens: 410 },
  { day: 'Wed', tokens: 380 },
  { day: 'Thu', tokens: 450 },
  { day: 'Fri', tokens: 520 },
  { day: 'Sat', tokens: 280 },
  { day: 'Sun', tokens: 237 },
]

export default function Dashboard() {
  const gw = mockGatewayStatus

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Dashboard</h1>

      {/* System Health */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Server className="h-4 w-4" />
            System Health
            <Badge variant={gw.status === 'healthy' ? 'default' : 'destructive'} className="ml-auto text-[10px]">
              {gw.status}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-5 gap-4 text-xs">
            <div>
              <div className="text-muted-foreground">Uptime</div>
              <div className="font-medium">{formatUptime(gw.uptime)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Agents</div>
              <div className="font-medium">{gw.agentCount}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Sessions</div>
              <div className="font-medium">{gw.activeSessions} active</div>
            </div>
            <div>
              <div className="text-muted-foreground">CPU</div>
              <div className="font-medium">{gw.cpu}%</div>
            </div>
            <div>
              <div className="text-muted-foreground">Errors (1h)</div>
              <div className="font-medium flex items-center gap-1">
                {gw.errors1h ?? 0}
                {gw.errors1h! > 0 && <AlertTriangle className="h-3 w-3 text-yellow-500" />}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        {/* Agent Cards */}
        <div className="col-span-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold mb-3">
            <Bot className="h-4 w-4" />
            Agent Status
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {mockAgents.map(a => <AgentCard key={a.id} agent={a} />)}
          </div>
        </div>

        {/* Activity + Chart */}
        <div className="space-y-4">
          {/* Chart */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Zap className="h-4 w-4" />
                Token Usage (7d)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="#888" />
                    <YAxis tick={{ fontSize: 10 }} stroke="#888" />
                    <Tooltip
                      contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a3e', borderRadius: '6px', fontSize: 12 }}
                      labelStyle={{ color: '#888' }}
                      formatter={(v: number) => [`${v}K tokens`, 'Tokens']}
                    />
                    <Bar dataKey="tokens" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Activity Feed */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Activity className="h-4 w-4" />
                Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-72">
                <div className="px-4 space-y-2 pb-4">
                  {mockActivity.map(ev => (
                    <div key={ev.id} className="flex items-start gap-2 text-xs">
                      <span className="text-muted-foreground shrink-0 w-10 tabular-nums">{timeStr(ev.timestamp)}</span>
                      <span>{eventIcon(ev.type)}</span>
                      <div className="min-w-0">
                        {ev.agentName && <span className="font-medium text-foreground">{ev.agentName}</span>}
                        <span className="text-muted-foreground"> — {ev.description}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
