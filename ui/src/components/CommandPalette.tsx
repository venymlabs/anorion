import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command } from '@/components/ui/command'
import { Dialog, DialogContent } from '@/components/ui/dialog'

const commands = [
  { label: 'Dashboard', desc: 'Go to Dashboard', route: '/' },
  { label: 'Agents', desc: 'View all agents', route: '/agents' },
  { label: 'Sessions', desc: 'Browse sessions', route: '/sessions' },
  { label: 'Tools', desc: 'Tool registry', route: '/tools' },
  { label: 'Jobs', desc: 'Cron scheduler', route: '/jobs' },
  { label: 'Config', desc: 'Gateway settings', route: '/config' },
  { label: 'Agent: Vex Capital', desc: 'Open agent detail', route: '/agents/trader' },
  { label: 'Agent: Hermes', desc: 'Open agent detail', route: '/agents/hermes' },
  { label: 'Session: trader:dm:12345', desc: 'Open session inspector', route: '/sessions/trader:dm:12345' },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  // Reset query when opening
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const filtered = commands.filter(c =>
    c.label.toLowerCase().includes(query.toLowerCase()) ||
    c.desc.toLowerCase().includes(query.toLowerCase())
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 shadow-lg sm:max-w-lg">
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
            <input
              placeholder="Type a command or search..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex h-12 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-64 overflow-auto">
            {filtered.map((cmd) => (
              <div
                key={cmd.route}
                className="flex cursor-pointer items-center justify-between px-2 py-2 text-sm hover:bg-accent"
                onClick={() => {
                  navigate(cmd.route)
                  onOpenChange(false)
                }}
              >
                <div>
                  <div className="font-medium">{cmd.label}</div>
                  <div className="text-xs text-muted-foreground">{cmd.desc}</div>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">No results found.</div>
            )}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
