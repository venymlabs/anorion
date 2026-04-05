"use client";

import type { Agent } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Wrench, Trash2, ExternalLink } from "lucide-react";
import Link from "next/link";

interface AgentCardProps {
  agent: Agent;
  onDelete: () => void;
}

export function AgentCard({ agent, onDelete }: AgentCardProps) {
  const stateColors: Record<string, string> = {
    idle: "bg-green-500",
    processing: "bg-yellow-500",
    waiting: "bg-blue-500",
    error: "bg-red-500",
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between pb-2">
        <div className="space-y-1">
          <CardTitle className="text-base">{agent.name}</CardTitle>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className={`h-2 w-2 rounded-full ${stateColors[agent.state] || "bg-gray-400"}`} />
            {agent.state}
          </div>
        </div>
        <div className="flex gap-1">
          <Link href={`/agents/${agent.id}`}>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive"
            onClick={() => {
              if (confirm(`Delete agent "${agent.name}"?`)) onDelete();
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          <div className="text-muted-foreground">
            Model: <span className="font-medium text-foreground">{agent.model}</span>
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <Wrench className="h-3 w-3" />
            <span>{agent.tools.length} tools</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {agent.tags?.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
