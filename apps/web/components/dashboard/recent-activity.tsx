"use client";

import { Bot, MessageSquare, Wrench, Settings } from "lucide-react";

const mockActivity = [
  {
    id: "1",
    icon: MessageSquare,
    text: "Chat session started with Agent-1",
    time: "2 minutes ago",
  },
  {
    id: "2",
    icon: Wrench,
    text: "Tool executed: web-search on Agent-2",
    time: "5 minutes ago",
  },
  {
    id: "3",
    icon: Bot,
    text: "Agent-3 created",
    time: "1 hour ago",
  },
  {
    id: "4",
    icon: Settings,
    text: "API key rotated",
    time: "3 hours ago",
  },
  {
    id: "5",
    icon: MessageSquare,
    text: "Session ended with Agent-1",
    time: "5 hours ago",
  },
];

export function RecentActivity() {
  return (
    <div className="space-y-4">
      {mockActivity.map((item) => (
        <div key={item.id} className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
            <item.icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium leading-none">{item.text}</p>
            <p className="text-xs text-muted-foreground">{item.time}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
