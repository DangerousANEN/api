import { All, Controller, Logger, Param, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import * as http from "http";
import { GameStreamerService } from "../matches/game-streamer/game-streamer.service";

// F2: public read-only HUD stream for OBS browser sources.
//
// Caddy on the host should reverse-proxy `https://hud.cs2.zxc1x1.ru/{matchId}`
// (and the `/{matchId}/...` subpaths) to this controller. From here we proxy
// straight at the OpenHud overlay running inside the live streamer pod on
// port 1349 via the in-cluster service `gs-live-<matchId>:1349`.
//
// We deliberately don't require auth on this endpoint: OBS browser sources
// can't carry session cookies and the HUD payload is non-sensitive (game
// state that's already exposed in the public HLS stream). To rate-limit or
// add a signed token, wrap this in a guard later.
//
// Suggested Caddy snippet (host):
//   hud.cs2.zxc1x1.ru {
//     reverse_proxy /* https://cs2.zxc1x1.ru {
//       header_up Host {upstream_hostport}
//       transport http { tls_insecure_skip_verify }
//     }
//     # rewrite /matchId/path → /hud-stream/matchId/path
//     rewrite * /hud-stream{uri}
//   }
//
// Or simpler — since the API is reachable via the same panel ingress, just
// expose:
//   hud.cs2.zxc1x1.ru { reverse_proxy https://api.5stack.svc:5585 }
// and let Caddy route the entire /:matchId/... tree through this controller.
@Controller("hud-stream/:matchId")
export class HudStreamController {
  private readonly namespace =
    process.env.GAME_SERVERS_NAMESPACE ?? "5stack";

  constructor(private readonly logger: Logger) {}

  @All("*")
  async proxy(
    @Param("matchId") matchId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9-]{4,80}$/.test(matchId)) {
      res.status(400).send("invalid matchId");
      return;
    }
    const subPath =
      ((req.params as Record<string, string>)[0] ?? "").replace(/^\/+/, "") ||
      "index.html";
    const search = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";

    const serviceName = GameStreamerService.GetLiveServiceName(matchId);
    const upstreamHost = `${serviceName}.${this.namespace}.svc.cluster.local`;

    // Strip hop-by-hop headers and the panel auth cookie before forwarding.
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (
        lower === "host" ||
        lower === "connection" ||
        lower === "cookie" ||
        lower === "authorization" ||
        lower === "content-length" ||
        lower === "transfer-encoding"
      ) {
        continue;
      }
      if (v !== undefined) headers[lower] = v as string | string[];
    }
    headers["x-forwarded-for"] =
      (req.headers["x-forwarded-for"] as string | undefined) ||
      req.socket.remoteAddress ||
      "";
    headers["x-forwarded-proto"] =
      (req.headers["x-forwarded-proto"] as string | undefined) || "https";
    headers["host"] = `${upstreamHost}:1349`;

    const upstreamReq = http.request(
      {
        host: upstreamHost,
        port: 1349,
        path: `/${subPath}${search}`,
        method: req.method,
        headers,
        timeout: 30_000,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (v === undefined) continue;
          const lower = k.toLowerCase();
          if (
            lower === "transfer-encoding" ||
            lower === "connection" ||
            lower === "set-cookie"
          ) {
            continue;
          }
          res.setHeader(k, v as string | string[]);
        }
        // OBS browser sources benefit from short caching: HUD updates fast.
        res.setHeader("cache-control", "no-store, max-age=0");
        res.status(status);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (error) => {
      this.logger.warn(
        `[hud-stream ${matchId}] upstream error: ${(error as Error).message}`,
      );
      if (!res.headersSent) {
        res
          .status(502)
          .json({ error: "upstream_unavailable", match_id: matchId });
      } else {
        res.destroy();
      }
    });
    upstreamReq.on("timeout", () => {
      this.logger.warn(`[hud-stream ${matchId}] upstream timeout`);
      upstreamReq.destroy(new Error("timeout"));
    });

    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.readable
    ) {
      req.pipe(upstreamReq);
    } else {
      upstreamReq.end();
    }
  }
}
