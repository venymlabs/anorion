"use client";

import type { SystemStats } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot, MessageSquare, Coins, Wrench } from "lucide-react";

interface StatsCardsProps {
  stats: SystemStats;
}

export function StatsCards({ stats }: StatsCardsProps) {
  const cards = [
    {
      title: "Agents",
      value: stats.agents.total,
      sub: `${stats.agents.active} active`,
      icon: Bot,
    },
    {
      title: "Sessions",
      value: stats.sessions.total,
      sub: `${stats.sessions.active} active`,
      icon: MessageSquare,
    },
    {
      title: "Token Usage",
      value: `${((stats.tokens.used / stats.tokens.budget) * 100).toFixed(1)}%`,
      sub: `${(stats.tokens.used / 1000).toFixed(1)}k / ${(stats.tokens.budget / 1000).toFixed(0)}k`,
      icon: Coins,
    },
    {
      title: "Tools",
      value: stats.tools,
      sub: "registered",
      icon: Wrench,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{card.value}</div>
            <p className="text-xs text-muted-foreground">{card.sub}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
