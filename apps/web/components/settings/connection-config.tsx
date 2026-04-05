"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

export function ConnectionConfig() {
  const [url, setUrl] = useState(
    process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4250",
  );
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<
    "connected" | "disconnected" | null
  >(null);

  const checkConnection = async () => {
    setChecking(true);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        setStatus("connected");
      } else {
        setStatus("disconnected");
      }
    } catch {
      setStatus("disconnected");
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    checkConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gateway Connection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="gatewayUrl">Gateway URL</Label>
          <div className="flex gap-2">
            <Input
              id="gatewayUrl"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:4250"
            />
            <Button onClick={checkConnection} disabled={checking}>
              {checking ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Test
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Status:</span>
          {status === "connected" ? (
            <Badge variant="default" className="bg-green-600">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Connected
            </Badge>
          ) : status === "disconnected" ? (
            <Badge variant="destructive">
              <XCircle className="mr-1 h-3 w-3" />
              Disconnected
            </Badge>
          ) : (
            <Badge variant="secondary">Unknown</Badge>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          The gateway URL is configured via NEXT_PUBLIC_GATEWAY_URL. API requests are
          proxied through Next.js rewrites to avoid CORS issues.
        </p>
      </CardContent>
    </Card>
  );
}
