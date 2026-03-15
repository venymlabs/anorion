import { useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Bot, MessageSquare, Wrench, Package,
  Clock, Settings, ChevronLeft, ChevronRight, Search,
  Wifi, WifiOff, Key
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { CommandPalette } from '@/components/CommandPalette'
import { getApiKey, BASE_URL } from '@/api/client'
import { useEffect } from 'react'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/agents', icon: Bot, label: 'Agents' },
  { to: '/sessions', icon: MessageSquare, label: 'Sessions' },
  { to: '/tools', icon: Wrench, label: 'Tools' },
  { to: '/jobs', icon: Clock, label: 'Jobs' },
  { to: '/config', icon: Settings, label: 'Config' },
]

export default function RootLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [connected, setConnected] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showKeyInput, setShowKeyInput] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCmdOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Check if API key exists
  const apiKey = getApiKey()
  useEffect(() => {
    if (apiKey) setShowKeyInput(false)
  }, [apiKey])

  return (
    <div className="dark flex h-screen bg-background text-foreground">
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />

      {/* Sidebar */}
      <aside className={`flex flex-col border-r border-border bg-card transition-all duration-200 ${collapsed ? 'w-14' : 'w-52'}`}>
        <div className="flex items-center justify-between p-3">
          {!collapsed && <span className="font-bold text-sm">⚡ Anorion</span>}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>
        <nav className="flex-1 space-y-1 px-2">
          {navItems.map(({ to, icon: Icon, label }) => {
            const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
            return (
              <Link key={to} to={to} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}>
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{label}</span>}
              </Link>
            )
          })}
        </nav>
        <div className="border-t border-border p-2">
          {!collapsed && <div className="text-xs text-muted-foreground">v0.1.0-alpha</div>}
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-12 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-muted-foreground" onClick={() => setCmdOpen(true)}>
              <Search className="h-3.5 w-3.5" />
              <span className="text-xs">Search</span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[10px]">⌘K</kbd>
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs">
              {connected ? <Wifi className="h-3 w-3 text-green-500" /> : <WifiOff className="h-3 w-3 text-muted-foreground" />}
              <span className="text-muted-foreground">{BASE_URL.replace('http://', '')}</span>
            </div>
            {!showKeyInput && (
              <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => setShowKeyInput(true)}>
                <Key className="h-3 w-3" />
                <span className="text-xs">{apiKey ? 'API Key set' : 'Set API Key'}</span>
              </Button>
            )}
            {showKeyInput && (
              <div className="flex items-center gap-1">
                <Input placeholder="Paste API key..." value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} className="h-7 w-52 text-xs" onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    localStorage.setItem('anorion_api_key', apiKeyInput.trim())
                    setShowKeyInput(false)
                    setApiKeyInput('')
                  }
                }} />
                <Button size="sm" className="h-7" onClick={() => {
                  localStorage.setItem('anorion_api_key', apiKeyInput.trim())
                  setShowKeyInput(false)
                  setApiKeyInput('')
                }}>Set</Button>
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto p-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
