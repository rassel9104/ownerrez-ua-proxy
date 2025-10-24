// server.js
import express from "express";
import { URL } from "url";

const app = express();

// --- Config ---
const PROXY_ORIGIN = "https://ownerrez-ua-proxy.onrender.com";
const APP_BASE = "https://app.ownerrez.com";
const API_BASE = "https://api.ownerrez.com";

const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";

// Credenciales OAuth (desde entorno si es posible)
const FALLBACK_CLIENT_ID = process.env.OWNERREZ_CLIENT_ID || "c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g";
const OWNERREZ_CLIENT_SECRET = process.env.OWNERREZ_CLIENT_SECRET || ""; // <-- PÓNLO EN RENDER
const FALLBACK_REDIRECT =
    process.env.GPT_REDIRECT_URI ||
    "https://chat.openai.com/aip/g-4c7fcb8735f81f7eda9337dc66fdc10c530695c2/oauth/callback";

// Salud
app.get("/__health", (req, res) => res.json({ ok: true }));

// Acepta cualquier body (incluye x-www-form-urlencoded)
app.use(express.raw({ type: () => true, limit: "10mb" }));

// -------- Utils --------
function cloneHeaders(req) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "content-length" || lk === "user-agent") continue;
        headers[k] = v;
    }
    headers["User-Agent"] = UA;
    return headers;
}

function ensureAuthorizeParams(u) {
    const q = u.searchParams;
    if (!q.get("client_id") || q.get("client_id").trim() === "") q.set("client_id", FALLBACK_CLIENT_ID);
    if (!q.get("redirect_uri") || q.get("redirect_uri").trim() === "") q.set("redirect_uri", FALLBACK_REDIRECT);
    if (!q.get("response_type")) q.set("response_type", "code");
}

async function proxyGeneric(req, res, targetBase) {
    const targetUrl = targetBase + req.originalUrl;
    const init = {
        method: req.method,
        headers: cloneHeaders(req),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual"
    };
    const resp = await fetch(targetUrl, init);
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
}

// --- Token: injerta Authorization Basic si falta ---
app.all("/oauth/access_token", async (req, res) => {
    const targetUrl = API_BASE + req.originalUrl;

    const headers = cloneHeaders(req);

    // Asegura Content-Type correcto si GPTBuilder lo omite
    if (!headers["content-type"]) headers["content-type"] = "application/x-www-form-urlencoded";

    // Si no viene Authorization Basic, lo creamos con client_id:secret
    const hasAuth = Object.keys(headers).some(k => k.toLowerCase() === "authorization");
    if (!hasAuth && OWNERREZ_CLIENT_SECRET) {
        const basic = Buffer.from(`${FALLBACK_CLIENT_ID}:${OWNERREZ_CLIENT_SECRET}`).toString("base64");
        headers["Authorization"] = `Basic ${basic}`;
    }

    const init = {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual"
    };

    const resp = await fetch(targetUrl, init);
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
});

// --- Authorize: normaliza y REDIRIGE a la web (no proxyear UI) ---
app.all("/oauth/authorize", (req, res) => {
    const u = new URL(req.url, PROXY_ORIGIN);
    ensureAuthorizeParams(u);
    const target = `${APP_BASE}${u.pathname}?${u.searchParams.toString()}`;
    return res.redirect(302, target);
});

// --- Web → redirección; API (/v2/...) → proxy ---
function isWebPath(path) {
    return (
        path.startsWith("/oauth/") ||
        path === "/oauth" ||
        path.startsWith("/login") ||
        path.startsWith("/signin") ||
        path.startsWith("/account") ||
        path.startsWith("/identity") ||
        path === "/"
    );
}

app.use((req, res) => {
    const pathname = new URL(req.url, PROXY_ORIGIN).pathname;
    if (isWebPath(pathname)) {
        const target = APP_BASE + req.originalUrl;
        return res.redirect(302, target);
    }
    return proxyGeneric(req, res, API_BASE);
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("UA proxy listening on", PORT));
