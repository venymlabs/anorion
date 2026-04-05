"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAgent, listTools } from "@/lib/client";
import type { ToolDefinition } from "@/lib/types";
import { AgentForm } from "@/components/agents/agent-form";
import type { CreateAgentInput } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEffect } from "react";

export default function NewAgentPage() {
  const router = useRouter();
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listTools().then(setTools).catch(() => setTools([]));
  }, []);

  const handleSubmit = async (data: CreateAgentInput) => {
    setLoading(true);
    try {
      const agent = await createAgent(data);
      router.push(`/agents/${agent.id}`);
    } catch (err) {
      console.error("Failed to create agent:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Create Agent</h1>
      <Card>
        <CardHeader>
          <CardTitle>Agent Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <AgentForm
            tools={tools}
            onSubmit={handleSubmit}
            loading={loading}
          />
        </CardContent>
      </Card>
    </div>
  );
}
