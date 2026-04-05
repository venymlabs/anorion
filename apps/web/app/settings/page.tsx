"use client";

import { useEffect, useState } from "react";
import {
  listApiKeys,
  createApiKey,
  deleteApiKey,
  listChannels,
  startChannel,
  stopChannel,
} from "@/lib/client";
import type { ApiKey, Channel } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConnectionConfig } from "@/components/settings/connection-config";
import { Plus, Trash2, Copy } from "lucide-react";

export default function SettingsPage() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  useEffect(() => {
    listApiKeys().then(setApiKeys).catch(() => setApiKeys([]));
    listChannels().then(setChannels).catch(() => setChannels([]));
  }, []);

  const handleCreateKey = async () => {
    if (!newKeyName) return;
    try {
      const result = await createApiKey(newKeyName, ["*"]);
      setCreatedKey(result.key);
      setNewKeyName("");
      listApiKeys().then(setApiKeys).catch(() => {});
    } catch (err) {
      console.error("Failed to create API key:", err);
    }
  };

  const handleDeleteKey = async (id: string) => {
    await deleteApiKey(id).catch(() => {});
    setApiKeys((prev) => prev.filter((k) => k.id !== id));
  };

  const handleToggleChannel = async (channel: Channel) => {
    try {
      if (channel.status === "running") {
        await stopChannel(channel.name);
      } else {
        await startChannel(channel.name);
      }
      listChannels().then(setChannels).catch(() => {});
    } catch (err) {
      console.error("Failed to toggle channel:", err);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Tabs defaultValue="connection">
        <TabsList>
          <TabsTrigger value="connection">Connection</TabsTrigger>
          <TabsTrigger value="api-keys">API Keys</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
        </TabsList>

        <TabsContent value="connection" className="mt-4">
          <ConnectionConfig />
        </TabsContent>

        <TabsContent value="api-keys" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">API Keys</h2>
            <Button size="sm" onClick={() => setShowCreateKey(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create Key
            </Button>
          </div>

          {apiKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No API keys configured
            </p>
          ) : (
            <div className="space-y-2">
              {apiKeys.map((key) => (
                <Card key={key.id}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <div className="font-medium">{key.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {key.prefix}... · Created{" "}
                        {new Date(key.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() => handleDeleteKey(key.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Create key dialog */}
          <Dialog open={showCreateKey} onOpenChange={setShowCreateKey}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create API Key</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                {createdKey ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Copy your API key now. You won&apos;t be able to see it again.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input value={createdKey} readOnly />
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => navigator.clipboard.writeText(createdKey)}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                    <Button
                      onClick={() => {
                        setCreatedKey(null);
                        setShowCreateKey(false);
                      }}
                    >
                      Done
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="keyName">Key Name</Label>
                      <Input
                        id="keyName"
                        value={newKeyName}
                        onChange={(e) => setNewKeyName(e.target.value)}
                        placeholder="e.g. My Dashboard"
                      />
                    </div>
                    <Button onClick={handleCreateKey} disabled={!newKeyName}>
                      Create
                    </Button>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </TabsContent>

        <TabsContent value="channels" className="mt-4 space-y-4">
          <h2 className="text-lg font-semibold">Channels</h2>
          {channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No channels configured. Start the gateway to register channels.
            </p>
          ) : (
            <div className="space-y-2">
              {channels.map((channel) => (
                <Card key={channel.name}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <div className="font-medium">{channel.name}</div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Badge variant="outline">{channel.type}</Badge>
                        <span
                          className={`h-2 w-2 rounded-full ${
                            channel.status === "running"
                              ? "bg-green-500"
                              : channel.status === "error"
                                ? "bg-red-500"
                                : "bg-gray-400"
                          }`}
                        />
                        {channel.status}
                      </div>
                    </div>
                    <Button
                      variant={
                        channel.status === "running" ? "destructive" : "default"
                      }
                      size="sm"
                      onClick={() => handleToggleChannel(channel)}
                    >
                      {channel.status === "running" ? "Stop" : "Start"}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
