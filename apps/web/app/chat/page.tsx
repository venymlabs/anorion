"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  listAgents,
  listSessions,
  streamMessage,
  sendMessage,
} from "@/lib/client";
import type { Agent, Session, Message, ToolCall } from "@/lib/types";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatInput } from "@/components/chat/chat-input";
import { AgentSelector } from "@/components/chat/agent-selector";
import { SessionList } from "@/components/chat/session-list";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { PanelLeftClose, PanelLeft } from "lucide-react";

export default function ChatPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [showSessions, setShowSessions] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (selectedAgent) {
      listSessions(selectedAgent.id)
        .then(setSessions)
        .catch(() => setSessions([]));
      setMessages([]);
      setActiveSession(null);
    }
  }, [selectedAgent]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  const handleSend = useCallback(
    async (content: string) => {
      if (!selectedAgent) return;

      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        sessionId: activeSession?.id || "new",
        agentId: selectedAgent.id,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setStreaming(true);

      // Accumulate assistant content
      let assistantContent = "";
      const toolCalls: ToolCall[] = [];
      const assistantId = `temp-assistant-${Date.now()}`;

      const assistantMsg: Message = {
        id: assistantId,
        sessionId: activeSession?.id || "new",
        agentId: selectedAgent.id,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      try {
        for await (const event of streamMessage(
          selectedAgent.id,
          content,
          activeSession?.id,
        )) {
          if (event.type === "token") {
            assistantContent += event.data as string;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: assistantContent }
                  : m,
              ),
            );
            scrollToBottom();
          } else if (event.type === "tool_call") {
            toolCalls.push(event.data as ToolCall);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, toolCalls: [...toolCalls] }
                  : m,
              ),
            );
          } else if (event.type === "done") {
            const data = event.data as { sessionId?: string };
            if (data?.sessionId && !activeSession) {
              setActiveSession({
                id: data.sessionId,
                agentId: selectedAgent.id,
                status: "active",
                tokensUsed: 0,
                messageCount: 2,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastActive: new Date().toISOString(),
              });
            }
          }
        }
      } catch {
        // Fallback to non-streaming
        try {
          const res = await sendMessage(
            selectedAgent.id,
            content,
            activeSession?.id,
          );
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? res.message : m,
            ),
          );
        } catch {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: "Error: Failed to get response" }
                : m,
            ),
          );
        }
      } finally {
        setStreaming(false);
      }
    },
    [selectedAgent, activeSession, scrollToBottom],
  );

  const handleSelectSession = useCallback(
    (session: Session) => {
      setActiveSession(session);
      setMessages([]);
      // TODO: load session messages when API supports it
    },
    [],
  );

  const handleNewChat = useCallback(() => {
    setActiveSession(null);
    setMessages([]);
  }, []);

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      {/* Session sidebar */}
      {showSessions && selectedAgent && (
        <div className="w-64 shrink-0 rounded-lg border bg-card">
          <div className="border-b p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Sessions</span>
              <Button variant="ghost" size="sm" onClick={handleNewChat}>
                New
              </Button>
            </div>
          </div>
          <SessionList
            sessions={sessions}
            activeId={activeSession?.id}
            onSelect={handleSelectSession}
          />
        </div>
      )}

      {/* Main chat area */}
      <div className="flex flex-1 flex-col rounded-lg border bg-card">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b p-3">
          <AgentSelector
            agents={agents}
            selected={selectedAgent}
            onSelect={setSelectedAgent}
          />
          {selectedAgent && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSessions(!showSessions)}
            >
              {showSessions ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeft className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>

        {/* Messages */}
        <ScrollArea className="flex-1 p-4" ref={scrollRef}>
          {!selectedAgent ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Select an agent to start chatting
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Send a message to start a conversation
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg) => (
                <ChatMessage key={msg.id} message={msg} />
              ))}
              {streaming && (
                <div className="text-sm text-muted-foreground animate-pulse">
                  Thinking...
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        {/* Input */}
        <div className="border-t p-3">
          <ChatInput onSend={handleSend} disabled={!selectedAgent || streaming} />
        </div>
      </div>
    </div>
  );
}
