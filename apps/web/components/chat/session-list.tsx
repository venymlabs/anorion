"use client";

import type { Session } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

interface SessionListProps {
  sessions: Session[];
  activeId?: string;
  onSelect: (session: Session) => void;
}

export function SessionList({
  sessions,
  activeId,
  onSelect,
}: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No sessions yet
      </div>
    );
  }

  return (
    <ScrollArea className="h-[calc(100%-3rem)]">
      <div className="space-y-1 p-2">
        {sessions.map((session) => (
          <button
            key={session.id}
            onClick={() => onSelect(session)}
            className={cn(
              "w-full rounded-md px-3 py-2 text-left text-sm transition-colors",
              activeId === session.id
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium truncate">
                {session.id.slice(0, 8)}
              </span>
              <span
                className={`h-2 w-2 rounded-full ${
                  session.status === "active"
                    ? "bg-green-500"
                    : session.status === "idle"
                      ? "bg-gray-400"
                      : "bg-red-400"
                }`}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {session.messageCount} msgs ·{" "}
              {new Date(session.lastActive).toLocaleDateString()}
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
