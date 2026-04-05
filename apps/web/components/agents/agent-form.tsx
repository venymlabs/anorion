"use client";

import { useState } from "react";
import type { Agent, ToolDefinition, CreateAgentInput } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-20250514",
  "gemini-2.0-flash",
  "gemini-2.5-pro",
  "mistral-large-latest",
];

interface AgentFormProps {
  initial?: Agent;
  tools: ToolDefinition[];
  onSubmit: (data: CreateAgentInput) => Promise<void>;
  loading?: boolean;
}

export function AgentForm({ initial, tools, onSubmit, loading }: AgentFormProps) {
  const [name, setName] = useState(initial?.name || "");
  const [model, setModel] = useState(initial?.model || MODELS[0]);
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt || "");
  const [selectedTools, setSelectedTools] = useState<string[]>(
    initial?.tools || [],
  );
  const [maxIterations, setMaxIterations] = useState(
    initial?.maxIterations?.toString() || "10",
  );

  const toggleTool = (toolName: string) => {
    setSelectedTools((prev) =>
      prev.includes(toolName)
        ? prev.filter((t) => t !== toolName)
        : [...prev, toolName],
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      model,
      systemPrompt,
      tools: selectedTools,
      maxIterations: parseInt(maxIterations, 10) || 10,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Agent name"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="model">Model</Label>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger>
            <SelectValue placeholder="Select model" />
          </SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="systemPrompt">System Prompt</Label>
        <Textarea
          id="systemPrompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You are a helpful assistant..."
          rows={6}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="maxIterations">Max Iterations</Label>
        <Input
          id="maxIterations"
          type="number"
          value={maxIterations}
          onChange={(e) => setMaxIterations(e.target.value)}
          min={1}
          max={100}
        />
      </div>

      <div className="space-y-2">
        <Label>Tools</Label>
        <div className="flex flex-wrap gap-2">
          {tools.map((tool) => (
            <Badge
              key={tool.name}
              variant={selectedTools.includes(tool.name) ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => toggleTool(tool.name)}
            >
              {tool.name}
            </Badge>
          ))}
          {tools.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No tools available — start the gateway to load tools
            </p>
          )}
        </div>
      </div>

      <Button type="submit" disabled={loading || !name || !systemPrompt}>
        {loading ? "Saving..." : initial ? "Update Agent" : "Create Agent"}
      </Button>
    </form>
  );
}
