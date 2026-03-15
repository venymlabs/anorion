import type { AgentStatus } from '@/api/types'

const statusColors: Record<AgentStatus, string> = {
  active: 'bg-green-500',
  idle: 'bg-yellow-500',
  suspended: 'bg-blue-500',
  error: 'bg-red-500',
  shutting_down: 'bg-gray-500',
}

const statusLabels: Record<AgentStatus, string> = {
  active: 'Active',
  idle: 'Idle',
  suspended: 'Suspended',
  error: 'Error',
  shutting_down: 'Shutting Down',
}

export function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${statusColors[status]}`} />
      <span className="text-xs">{statusLabels[status]}</span>
    </span>
  )
}
