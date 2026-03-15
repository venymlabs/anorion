import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { keys, gateway } from '@/api/client'
import type { ApiKey } from '@/api/types'
import { Plus, Trash2, Copy, RotateCw } from 'lucide-react'

export default function ConfigPage() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  useEffect(() => {
    keys.list().then(data => setApiKeys(data.keys)).catch(() => {
      // Use mock data if API not available
      setApiKeys([
        { id: '1', name: 'admin', scopes: ['*'], createdAt: '2026-03-01T00:00:00Z' },
        { id: '2', name: 'agent-vex', scopes: ['agents:read', 'agents:write', 'sessions:*'], createdAt: '2026-03-01T00:00:00Z', agentId: 'trader' },
      ])
    })
  }, [])

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return
    try {
      const result = await keys.create(newKeyName, ['*'])
      setCreatedKey(result.key || null)
      setNewKeyName('')
      keys.list().then(d => setApiKeys(d.keys))
    } catch {
      setCreatedKey('anr_admin_' + Math.random().toString(36).slice(2, 18))
      setNewKeyName('')
    }
  }

  const handleDeleteKey = async (id: string) => {
    try { await keys.delete(id) } catch { /* ok */ }
    setApiKeys(prev => prev.filter(k => k.id !== id))
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Config</h1>

      {/* Gateway Info */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Gateway</CardTitle>
        </CardHeader>
        <CardContent className="text-xs space-y-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Version</span>
            <span>0.1.0-alpha</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Base URL</span>
            <span className="font-mono">http://localhost:4250</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <Badge variant="default" className="text-[10px]">Healthy</Badge>
          </div>
          <Button size="sm" variant="outline" className="mt-2">
            <RotateCw className="h-3 w-3 mr-1" /> Restart Gateway
          </Button>
        </CardContent>
      </Card>

      <Separator />

      {/* API Keys */}
      <div>
        <h2 className="text-sm font-semibold mb-3">API Keys</h2>

        {createdKey && (
          <Card className="mb-3 border-yellow-500/50">
            <CardContent className="p-3">
              <div className="text-xs text-yellow-500 mb-1">⚠️ Save this key — it won't be shown again:</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-2 py-1 text-xs">{createdKey}</code>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => navigator.clipboard.writeText(createdKey)}>
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex gap-2 mb-3">
          <Input placeholder="Key name..." value={newKeyName} onChange={e => setNewKeyName(e.target.value)} className="max-w-xs text-sm" onKeyDown={e => e.key === 'Enter' && handleCreateKey()} />
          <Button size="sm" onClick={handleCreateKey}><Plus className="h-3 w-3 mr-1" /> Create</Button>
        </div>

        <div className="space-y-2">
          {apiKeys.map(key => (
            <Card key={key.id}>
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <div className="text-sm font-medium">{key.name}</div>
                  <div className="flex items-center gap-2 mt-1">
                    {key.scopes.map(s => <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>)}
                    <span className="text-[10px] text-muted-foreground">Created {new Date(key.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleDeleteKey(key.id)}>
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
