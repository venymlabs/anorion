"use client";

import { useEffect, useState } from "react";
import { listAgents, listSessions, deleteSession } from "@/lib/client";
import type { Agent, Session } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Trash2 } from "lucide-react";

export default function SessionsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    if (selectedAgent && selectedAgent !== "all") {
      listSessions(selectedAgent)
        .then(setSessions)
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
    } else {
      // Load sessions for all agents
      Promise.all(
        agents.map((a) => listSessions(a.id).catch(() => [])),
      )
        .then((results) => setSessions(results.flat()))
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
    }
  }, [selectedAgent, agents]);

  const filtered = sessions.filter((s) => {
    if (statusFilter !== "all" && s.status !== statusFilter) return false;
    return true;
  });

  const handleDelete = async (agentId: string, sessionId: string) => {
    await deleteSession(agentId, sessionId).catch(() => {});
    if (selectedAgent && selectedAgent !== "all") {
      listSessions(selectedAgent).then(setSessions).catch(() => {});
    } else {
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    }
  };

  const statusColors: Record<string, string> = {
    active: "bg-green-500",
    idle: "bg-gray-400",
    destroyed: "bg-red-400",
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Sessions</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={selectedAgent} onValueChange={setSelectedAgent}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="idle">Idle</SelectItem>
            <SelectItem value="destroyed">Destroyed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Sessions table */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          No sessions found
        </div>
      ) : (
        <div className="rounded-lg border">
          <div className="grid grid-cols-[1fr_1fr_100px_100px_80px] gap-4 border-b p-3 text-sm font-medium text-muted-foreground">
            <span>Session ID</span>
            <span>Agent</span>
            <span>Messages</span>
            <span>Tokens</span>
            <span>Status</span>
          </div>
          {filtered.map((session) => {
            const agent = agents.find((a) => a.id === session.agentId);
            return (
              <div
                key={session.id}
                className="grid grid-cols-[1fr_1fr_100px_100px_80px] gap-4 border-b p-3 text-sm hover:bg-muted/50 cursor-pointer"
                onClick={() => setSelectedSession(session)}
              >
                <span className="font-mono text-xs">{session.id.slice(0, 16)}...</span>
                <span>{agent?.name || session.agentId.slice(0, 8)}</span>
                <span>{session.messageCount}</span>
                <span>{session.tokensUsed.toLocaleString()}</span>
                <span className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${statusColors[session.status] || "bg-gray-400"}`} />
                  {session.status}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Session detail dialog */}
      <Dialog
        open={!!selectedSession}
        onOpenChange={() => setSelectedSession(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Session Details</DialogTitle>
          </DialogHeader>
          {selectedSession && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-muted-foreground">ID</div>
                <div className="font-mono text-xs">{selectedSession.id}</div>
                <div className="text-muted-foreground">Status</div>
                <div>{selectedSession.status}</div>
                <div className="text-muted-foreground">Messages</div>
                <div>{selectedSession.messageCount}</div>
                <div className="text-muted-foreground">Tokens</div>
                <div>{selectedSession.tokensUsed.toLocaleString()}</div>
                <div className="text-muted-foreground">Created</div>
                <div>{new Date(selectedSession.createdAt).toLocaleString()}</div>
                <div className="text-muted-foreground">Last Active</div>
                <div>{new Date(selectedSession.lastActive).toLocaleString()}</div>
              </div>
              <div className="flex justify-end pt-4">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    handleDelete(selectedSession.agentId, selectedSession.id);
                    setSelectedSession(null);
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Session
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Message history loading requires the session messages API (not yet available on gateway).
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
