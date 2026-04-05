"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getAgent, updateAgent, listTools } from "@/lib/client";
import type { Agent, ToolDefinition, CreateAgentInput } from "@/lib/types";
import { AgentForm } from "@/components/agents/agent-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function EditAgentPage() {
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

  const handleSubmit = async (data: CreateAgentInput) => {
    setSaving(true);
    try {
      await updateAgent(id, data);
      router.push(`/agents/${id}`);
    } catch (err) {
      console.error("Failed to update agent:", err);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !agent) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Edit Agent</h1>
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Edit Agent</h1>
      <Card>
        <CardHeader>
          <CardTitle>{agent.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <AgentForm
            initial={agent}
            tools={tools}
            onSubmit={handleSubmit}
            loading={saving}
          />
        </CardContent>
      </Card>
    </div>
  );
}
