"use client";

import type { Agent } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AgentSelectorProps {
  agents: Agent[];
  selected: Agent | null;
  onSelect: (agent: Agent) => void;
}

export function AgentSelector({
  agents,
  selected,
  onSelect,
}: AgentSelectorProps) {
  return (
    <Select
      value={selected?.id || ""}
      onValueChange={(id) => {
        const agent = agents.find((a) => a.id === id);
        if (agent) onSelect(agent);
      }}
    >
      <SelectTrigger className="w-[200px]">
        <SelectValue placeholder="Select agent..." />
      </SelectTrigger>
      <SelectContent>
        {agents.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  agent.state === "idle"
                    ? "bg-green-500"
                    : agent.state === "processing"
                      ? "bg-yellow-500"
                      : agent.state === "error"
                        ? "bg-red-500"
                        : "bg-gray-400"
                }`}
              />
              {agent.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
