import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/StatusBadge'
import { mockAgents } from '@/lib/mock-data'
import { ArrowLeft } from 'lucide-react'

const exampleConfig = `name: "Vex Capital"
model:
  model: "anthropic/claude-sonnet-4-20250514"
  fallbacks:
    - model: "openai/gpt-4o"
      retryOn: [429, 503]
  params:
    temperature: 0.3
    maxTokens: 8192
tools:
  - hyperliquid
  - coingecko
  - web-search
  - web-fetch
  - file-read
  - file-write
skills:
  - perps-trader
memory:
  shortTerm:
    maxMessages: 60
  longTerm:
    directory: ./memory/trading/
permissions:
  allow:
    - trading.*
    - external.api.*
  deny:
    - agent.spawn
maxIterations: 20
timeoutMs: 60000`

export function AgentsPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Agents</h1>
        <Button size="sm">+ New Agent</Button>
      </div>
      <div className="space-y-2">
        {mockAgents.map(a => (
          <Card key={a.id} className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate(`/agents/${a.id}`)}>
            <CardContent className="flex items-center justify-between p-3">
              <div className="flex items-center gap-4">
                <div>
                  <span className="font-medium text-sm">{a.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{a.id}</span>
                </div>
                <StatusBadge status={a.status} />
              </div>
              <div className="flex items-center gap-6 text-xs text-muted-foreground">
                <span>{a.model}</span>
                <span>{a.activeSessions} sessions</span>
                <span>{(a.tokensToday / 1000).toFixed(0)}K tokens</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

export function AgentDetailPage({ agentId }: { agentId: string }) {
  const navigate = useNavigate()
  const agent = mockAgents.find(a => a.id === agentId)
  const [config, setConfig] = useState(exampleConfig)

  if (!agent) return <div className="text-muted-foreground">Agent not found</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => navigate('/agents')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">{agent.name}</h1>
          <StatusBadge status={agent.status} />
        </div>
      </div>

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Info</CardTitle></CardHeader>
              <CardContent className="text-xs space-y-1">
                <div><span className="text-muted-foreground">Model:</span> {agent.model}</div>
                <div><span className="text-muted-foreground">Sessions:</span> {agent.activeSessions} active</div>
                <div><span className="text-muted-foreground">Tokens today:</span> {(agent.tokensToday / 1000).toFixed(0)}K</div>
                <div><span className="text-muted-foreground">Last active:</span> {new Date(agent.lastActive).toLocaleString()}</div>
                <div><span className="text-muted-foreground">Tags:</span> {agent.tags?.join(', ')}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Actions</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline">Restart</Button>
                <Button size="sm" variant="outline">Pause</Button>
                <Button size="sm" variant="outline">Spawn Sub-agent</Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="config" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm">Agent Config (YAML)</CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline">Revert</Button>
                <Button size="sm">Save</Button>
              </div>
            </CardHeader>
            <CardContent>
              <textarea
                value={config}
                onChange={(e) => setConfig(e.target.value)}
                className="w-full h-[500px] rounded-md border border-border bg-muted/50 p-4 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                spellCheck={false}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tools" className="mt-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Bound Tools</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {['hyperliquid', 'coingecko', 'web-search', 'web-fetch', 'file-read', 'file-write'].map(t => (
                  <Badge key={t} variant="secondary">{t}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sessions" className="mt-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Active Sessions</CardTitle></CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              Click a session in the Sessions page to inspect it.
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

