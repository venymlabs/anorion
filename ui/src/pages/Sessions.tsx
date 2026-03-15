import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusBadge } from '@/components/StatusBadge'
import { mockSessions, mockActivity } from '@/lib/mock-data'
import { ArrowLeft, Send, Pause, AlertCircle, CheckCircle, Wrench } from 'lucide-react'

function timeStr(d: string) {
  return new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function SessionsPage() {
  const navigate = useNavigate()
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Sessions</h1>
      <div className="space-y-2">
        {mockSessions.map(s => (
          <Card key={s.id} className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate(`/sessions/${s.id}`)}>
            <CardContent className="flex items-center justify-between p-3">
              <div className="flex items-center gap-4 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{s.id}</span>
                <span className="font-medium">{s.agentName || s.agentId}</span>
                <Badge variant="secondary" className="text-[10px]">{s.status}</Badge>
              </div>
              <div className="flex items-center gap-6 text-xs text-muted-foreground">
                <span>{s.messageCount} msgs</span>
                <span>{(s.tokens / 1000).toFixed(0)}K tok</span>
                <span>Last: {timeStr(s.lastActive)}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate()
  const session = mockSessions.find(s => s.id === sessionId)
  const [input, setInput] = useState('')

  if (!session) return <div className="text-muted-foreground">Session not found</div>

  // Mock messages for the inspector
  const messages = [
    { id: '1', role: 'user' as const, content: "What's the current ETH price? Check on Hyperliquid and compare with Binance spot.", timestamp: '2026-03-15T13:20:15Z' },
    { id: '2', role: 'assistant' as const, content: 'Let me check the current prices.', timestamp: '2026-03-15T13:20:16Z', toolCalls: [
      { id: 'tc1', name: 'coingecko.price', input: { coin: 'ethereum' }, output: { usd: 3847.23, change_24h: 2.4 }, durationMs: 340, status: 'success' as const },
      { id: 'tc2', name: 'hyperliquid.get_price', input: { coin: 'ETH' }, output: { price: 3848.50, funding: 0.0001 }, durationMs: 890, status: 'success' as const },
    ]},
    { id: '3', role: 'assistant' as const, content: "Here's the current ETH pricing:\n\n| Source | Price | 24h Change |\n|--------|-------|------------|\n| CoinGecko | $3,847.23 | +2.4% |\n| Hyperliquid | $3,848.50 | +2.5% |\n| Spread | $1.27 | |\n\nThe Hyperliquid perp price is slightly above spot, with a funding rate of 0.01% — neutral to slightly bullish.", timestamp: '2026-03-15T13:20:17Z' },
  ]

  const toolCalls = messages.flatMap(m => (m as any).toolCalls || []).map(tc => ({ ...tc, timestamp: '2026-03-15T13:20:16Z' }))

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      {/* Message Stream */}
      <div className="flex flex-1 flex-col rounded-lg border border-border">
        <div className="flex items-center gap-3 border-b border-border px-3 py-2">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => navigate('/sessions')}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="font-mono text-xs text-muted-foreground">{sessionId}</span>
          <Badge variant="secondary" className="text-[10px]">{session.status}</Badge>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs text-muted-foreground">Live</span>
          </div>
        </div>
        <ScrollArea className="flex-1 p-4">
          <div className="space-y-4">
            {messages.map(msg => (
              <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                {msg.role !== 'user' && (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs">
                    🤖
                  </div>
                )}
                <div className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                  <pre className="whitespace-pre-wrap font-sans text-sm">{msg.content}</pre>
                </div>
                {msg.role === 'user' && (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs">
                    🧑
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>

        {/* Input */}
        <div className="border-t border-border p-3">
          <div className="flex gap-2">
            <Input placeholder="Type message to inject..." value={input} onChange={e => setInput(e.target.value)} className="text-sm" />
            <Button size="sm"><Send className="h-3.5 w-3.5" /></Button>
          </div>
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" variant="outline" className="h-6 text-xs">Steer</Button>
            <Button size="sm" variant="outline" className="h-6 text-xs">Fork</Button>
            <Button size="sm" variant="outline" className="h-6 text-xs">Compact</Button>
            <Button size="sm" variant="destructive" className="h-6 text-xs">Stop</Button>
          </div>
        </div>
      </div>

      {/* Tool Timeline */}
      <div className="w-72 rounded-lg border border-border">
        <div className="border-b border-border px-3 py-2 text-sm font-medium">Tool Timeline</div>
        <ScrollArea className="h-full">
          <div className="p-2 space-y-2">
            {toolCalls.map((tc: any) => (
              <div key={tc.id} className="rounded-md border border-border p-2 text-xs">
                <div className="flex items-center gap-1.5">
                  <Wrench className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{tc.name}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                  <span>{tc.durationMs}ms</span>
                  {tc.status === 'success' ? <CheckCircle className="h-3 w-3 text-green-500" /> : <AlertCircle className="h-3 w-3 text-red-500" />}
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted-foreground">Details</summary>
                  <pre className="mt-1 rounded bg-muted p-1.5 text-[10px] overflow-auto max-h-24">{JSON.stringify({ input: tc.input, output: tc.output }, null, 2)}</pre>
                </details>
              </div>
            ))}
            {toolCalls.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">No tool calls yet</div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
