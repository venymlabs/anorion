"use client";

import { useState } from "react";
import type { ToolDefinition } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Play } from "lucide-react";

interface ToolExecutorProps {
  tool: ToolDefinition;
  onExecute: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

export function ToolExecutor({ tool, onExecute }: ToolExecutorProps) {
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Extract parameter names from JSON Schema
  const properties: Record<string, { type: string; description?: string }> =
    (tool.parameters?.properties as Record<string, { type: string; description?: string }>) || {};

  const handleExecute = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // Parse JSON values, keep strings as-is
      const parsed: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(params)) {
        try {
          parsed[key] = JSON.parse(val);
        } catch {
          parsed[key] = val;
        }
      }
      const res = await onExecute(tool.name, parsed);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Execution failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-sm">{tool.name}</CardTitle>
        <p className="text-xs text-muted-foreground">{tool.description}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {Object.keys(properties).length === 0 ? (
          <p className="text-sm text-muted-foreground">No parameters required</p>
        ) : (
          Object.entries(properties).map(([name, schema]) => (
            <div key={name} className="space-y-1">
              <Label htmlFor={name} className="text-xs">
                {name}
                <span className="ml-1 text-muted-foreground">
                  ({schema.type})
                </span>
              </Label>
              <Input
                id={name}
                value={params[name] || ""}
                onChange={(e) =>
                  setParams((prev) => ({ ...prev, [name]: e.target.value }))
                }
                placeholder={schema.description || name}
                className="text-sm"
              />
            </div>
          ))
        )}

        <Button onClick={handleExecute} disabled={loading} size="sm">
          <Play className="mr-2 h-3 w-3" />
          {loading ? "Running..." : "Execute"}
        </Button>

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {result !== null && (
          <div className="space-y-1">
            <Label className="text-xs">Result</Label>
            <ScrollArea className="h-48 rounded-md bg-muted p-3">
              <pre className="text-xs">
                {JSON.stringify(result, null, 2)}
              </pre>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
