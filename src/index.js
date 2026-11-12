import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import wisp from "wisp-server-node";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 設定 (環境変数) ----------
const PORT = process.env.PORT || 8080;
const PASSWORD = process.env.ACCESS_PASSWORD || "";            // 未設定なら認証なし(非推奨)
let ENTRY_PATH = process.env.ENTRY_PATH || "/_login";           // 秘密のログインURL。変更推奨
if (!ENTRY_PATH.startsWith("/")) ENTRY_PATH = "/" + ENTRY_PATH;
const MAX_CONNS = Number(process.env.MAX_CONNS) || 200;         // Wisp同時接続数の上限
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex"); // 未設定だと再起動でログアウト
const AUTH = PASSWORD !== "";
const COOKIE = "sid";

// ---------- 認証まわり ----------
const sha = (s) => createHash("sha256").update(s).digest();
// ハッシュ同士を定数時間で比較 (Go版のConstantTimeCompare相当)
const safeEq = (a, b) => timingSafeEqual(sha(String(a)), sha(String(b)));
const SESSION_TOKEN = createHmac("sha256", SESSION_SECRET).update("session").digest("hex");

function getCookie(header, name) {
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
const isAuthed = (headers) => !AUTH || safeEq(getCookie(headers.cookie, COOKIE), SESSION_TOKEN);

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",").pop().trim();
  return req.socket.remoteAddress || "unknown";
}

// ログイン総当たり対策: 5回失敗で10分ブロック
const fails = new Map();
const MAX_FAILS = 5, BLOCK_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of fails) if (f.until < now && f.count < MAX_FAILS) fails.delete(ip);
}, 60 * 1000).unref();

// ---------- 見せかけのサイト ----------
let DECOY = "<!doctype html><title>Welcome</title><h1>Welcome</h1>";
try { DECOY = readFileSync(join(__dirname, "../decoy/index.html"), "utf8"); } catch {}

const loginPage = (msg = "") => `<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7fb}
form{background:#fff;padding:28px;border-radius:14px;border:1px solid #dfe2ec;display:flex;flex-direction:column;gap:12px;width:min(320px,90vw)}
input,button{padding:12px;border-radius:10px;border:1px solid #dfe2ec;font-size:16px}
button{background:#5b5bf0;color:#fff;border:0;cursor:pointer}p{margin:0;color:#c0392b;font-size:14px}</style>
<form method="post" action="${ENTRY_PATH}"><input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<button>Enter</button>${msg ? `<p>${msg}</p>` : ""}</form></html>`;

// ---------- Wisp (SSRF対策) ----------
try {
  wisp.options.allow_private_ips = false;
  wisp.options.allow_loopback_ips = false;
} catch {}

// ---------- Express ----------
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

if (AUTH) {
  // ログインフォーム (秘密のURLを知っている人だけがたどり着ける)
  app.get(ENTRY_PATH, (req, res) => res.type("html").send(loginPage()));
  app.post(ENTRY_PATH, express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
    const ip = clientIp(req);
    const f = fails.get(ip) || { count: 0, until: 0 };
    if (f.until > Date.now()) return res.status(429).type("html").send(loginPage("しばらくしてからもう一度試してください"));

    if (safeEq(req.body?.password ?? "", PASSWORD)) {
      fails.delete(ip);
      res.cookie(COOKIE, SESSION_TOKEN, {
        httpOnly: true, sameSite: "lax", secure: req.secure, path: "/", maxAge: 30 * 24 * 3600 * 1000,
      });
      return res.redirect("/");
    }
    f.count++;
    if (f.count >= MAX_FAILS) f.until = Date.now() + BLOCK_MS;
    fails.set(ip, f);
    res.status(401).type("html").send(loginPage("パスワードが違います"));
  });

  // 未認証: "/" には見せかけのサイト、それ以外は普通の404 (プロキシだと分からないようにする)
  app.use((req, res, next) => {
    if (isAuthed(req.headers)) return next();
    if (req.method === "GET" && req.path === "/") return res.type("html").send(DECOY);
    res.status(404).type("text/plain").send("Not Found");
  });
}

app.use(express.static(join(__dirname, "../public")));
app.use("/uv/", express.static(uvPath));
app.use("/epoxy/", express.static(epoxyPath));
app.use("/baremux/", express.static(baremuxPath));

const server = createServer(app);

// ---------- WebSocket (Wisp): 未認証・上限超過は理由を返さず切断 ----------
let active = 0;
server.on("upgrade", (req, socket, head) => {
  const ok = req.url && req.url.endsWith("/wisp/") && isAuthed(req.headers) && active < MAX_CONNS;
  if (!ok) return socket.destroy();
  active++;
  socket.once("close", () => { active--; });
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  if (AUTH) console.log(`ログインURL: <あなたのドメイン>${ENTRY_PATH}`);
  else console.warn("警告: ACCESS_PASSWORD が未設定です。誰でも使えます。");
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
