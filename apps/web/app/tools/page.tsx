"use client";

import { useEffect, useState } from "react";
import { listTools, executeTool } from "@/lib/client";
import type { ToolDefinition } from "@/lib/types";
import { ToolExecutor } from "@/components/tools/tool-executor";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wrench } from "lucide-react";

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTool, setSelectedTool] = useState<ToolDefinition | null>(null);

  useEffect(() => {
    listTools()
      .then(setTools)
      .catch(() => setTools([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Tools</h1>
        <div className="grid gap-4 md:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tools</h1>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Tool list */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">
            Registered Tools ({tools.length})
          </h2>
          {tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tools found. Start the gateway to register tools.
            </p>
          ) : (
            tools.map((tool) => (
              <Card
                key={tool.name}
                className={`cursor-pointer transition-colors hover:bg-accent/50 ${
                  selectedTool?.name === tool.name ? "ring-2 ring-primary" : ""
                }`}
                onClick={() => setSelectedTool(tool)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <Wrench className="h-4 w-4" />
                    <CardTitle className="text-sm font-mono">
                      {tool.name}
                    </CardTitle>
                    {tool.category && (
                      <Badge variant="outline" className="text-xs">
                        {tool.category}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {tool.description}
                  </p>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Tool playground */}
        <div>
          <h2 className="mb-3 text-lg font-semibold">Playground</h2>
          {selectedTool ? (
            <ToolExecutor tool={selectedTool} onExecute={executeTool} />
          ) : (
            <Card>
              <CardContent className="flex h-48 items-center justify-center text-muted-foreground">
                Select a tool to test it
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
