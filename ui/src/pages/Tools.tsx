import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { mockTools } from '@/lib/mock-data'
import { Wrench } from 'lucide-react'

export default function ToolsPage() {
  const categories = [...new Set(mockTools.map(t => t.category))]

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Tools</h1>
      <div className="text-xs text-muted-foreground">
        {mockTools.length} tools registered across {categories.length} categories
      </div>

      {categories.map(cat => (
        <div key={cat}>
          <h2 className="text-sm font-semibold mb-2 capitalize">{cat.replace(/-/g, ' ')}</h2>
          <div className="space-y-2">
            {mockTools.filter(t => t.category === cat).map(tool => (
              <Card key={tool.name}>
                <CardContent className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-3">
                    <Wrench className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-mono text-sm">{tool.name}</div>
                      <div className="text-xs text-muted-foreground">{tool.description}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {tool.boundAgents.map(a => (
                      <Badge key={a} variant="secondary" className="text-[10px]">{a}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
