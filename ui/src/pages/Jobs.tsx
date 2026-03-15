import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { mockJobs } from '@/lib/mock-data'
import { Play, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react'

export default function JobsPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Scheduled Jobs</h1>
        <Button size="sm">+ New Job</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="p-3">Name</th>
                <th className="p-3">Agent</th>
                <th className="p-3">Schedule</th>
                <th className="p-3">Status</th>
                <th className="p-3">Last Run</th>
                <th className="p-3">Next Run</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mockJobs.map(job => (
                <tr key={job.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="p-3 font-medium">{job.name}</td>
                  <td className="p-3 text-muted-foreground">{job.agentName}</td>
                  <td className="p-3 font-mono text-xs">{job.schedule}</td>
                  <td className="p-3">
                    <Badge variant={job.enabled ? 'default' : 'secondary'} className="text-[10px]">
                      {job.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">{job.lastRun ? new Date(job.lastRun).toLocaleString() : '—'}</td>
                  <td className="p-3 text-xs text-muted-foreground">{job.nextRun ? new Date(job.nextRun).toLocaleString() : '—'}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-6 w-6" title="Run now">
                        <Play className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6" title={job.enabled ? 'Disable' : 'Enable'}>
                        {job.enabled ? <ToggleRight className="h-3.5 w-3.5 text-green-500" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6" title="Delete">
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
