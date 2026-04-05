"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getAgent, listTools, updateAgent, deleteAgent } from "@/lib/client";
import type { Agent, ToolDefinition, CreateAgentInput } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentForm } from "@/components/agents/agent-form";
import { ArrowLeft, Trash2 } from "lucide-react";
import Link from "next/link";

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([getAgent(id), listTools()])
      .then(([a, t]) => {
        setAgent(a);
        setTools(t);
      })
      .catch(() => router.push("/agents"))
      .finally(() => setLoading(false));
  }, [id, router]);

  const handleUpdate = async (data: CreateAgentInput) => {
    setSaving(true);
    try {
      const updated = await updateAgent(id, data);
      setAgent(updated);
    } catch (err) {
      console.error("Failed to update agent:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this agent?")) return;
    try {
      await deleteAgent(id);
      router.push("/agents");
    } catch (err) {
      console.error("Failed to delete agent:", err);
    }
  };

  if (loading || !agent) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  const stateColors: Record<string, string> = {
    idle: "bg-green-500",
    processing: "bg-yellow-500",
    waiting: "bg-blue-500",
    error: "bg-red-500",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/agents">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">{agent.name}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className={`h-2 w-2 rounded-full ${stateColors[agent.state] || "bg-gray-400"}`} />
              {agent.state} · {agent.model}
            </div>
          </div>
        </div>
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
      </div>

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="tools">Tools ({agent.tools.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Edit Agent</CardTitle>
            </CardHeader>
            <CardContent>
              <AgentForm
                initial={agent}
                tools={tools}
                onSubmit={handleUpdate}
                loading={saving}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tools" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Enabled Tools</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {agent.tools.map((tool) => (
                  <Badge key={tool} variant="secondary">
                    {tool}
                  </Badge>
                ))}
                {agent.tools.length === 0 && (
                  <p className="text-sm text-muted-foreground">No tools enabled</p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
