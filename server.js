// server.js
import express from "express";
import { URL, URLSearchParams } from "url";

const app = express();

// --- Config ---
const PROXY_ORIGIN = "https://ownerrez-ua-proxy.onrender.com";
const APP_BASE = "https://app.ownerrez.com";
const API_BASE = "https://api.ownerrez.com";

const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";

// Credenciales OAuth (pon el secret en Render → Environment)
const CLIENT_ID = process.env.OWNERREZ_CLIENT_ID || "c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g";
const CLIENT_SECRET = process.env.OWNERREZ_CLIENT_SECRET || ""; // <-- IMPORTANTE
const REDIRECT_URI =
    process.env.GPT_REDIRECT_URI ||
    "https://chat.openai.com/aip/g-4c7fcb8735f81f7eda9337dc66fdc10c530695c2/oauth/callback";

// Salud
app.get("/__health", (req, res) => res.json({ ok: true }));

// Acepta cualquier body (token usa x-www-form-urlencoded)
app.use(express.raw({ type: () => true, limit: "10mb" }));

// -------- Utils --------
function cloneHeaders(req) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "content-length" || lk === "user-agent") continue;
        headers[k] = v;
    }
    headers["User-Agent"] = UA; // obligatorio en OwnerRez API
    return headers;
}

function ensureAuthorizeParams(u) {
    const q = u.searchParams;
    if (!q.get("client_id") || q.get("client_id").trim() === "") q.set("client_id", CLIENT_ID);
    if (!q.get("redirect_uri") || q.get("redirect_uri").trim() === "") q.set("redirect_uri", REDIRECT_URI);
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

app.all("/oauth/access_token", async (req, res) => {
    try {
        if (!CLIENT_SECRET) return res.status(500).json({ error: "OWNERREZ_CLIENT_SECRET not configured" });

        const headers = {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "Authorization": "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")
        };

        // 1) Lee el body original (ChatGPT envía form-urlencoded con grant_type, code, redirect_uri)
        const raw = req.body ? req.body.toString("utf8") : "";
        const inParams = new URLSearchParams(raw || "");

        // 2) Extrae code y redirect_uri del body o, si faltaran, de la query (fallback)
        let code = inParams.get("code");
        let redirect_uri = inParams.get("redirect_uri");
        if (!code) { const u = new URL(req.url, PROXY_ORIGIN); code = u.searchParams.get("code") || ""; }
        if (!redirect_uri) {
            const u = new URL(req.url, PROXY_ORIGIN);
            redirect_uri = u.searchParams.get("redirect_uri") || process.env.GPT_REDIRECT_URI || "";
        }
        if (!code) return res.status(400).json({ error: "missing_authorization_code" });
        if (!redirect_uri) return res.status(400).json({ error: "missing_redirect_uri" });

        // 3) Construye el form EXACTO preservando el redirect_uri actual del asistente
        const form = new URLSearchParams();
        form.set("grant_type", "authorization_code");
        form.set("code", code);
        form.set("redirect_uri", redirect_uri);

        const resp = await fetch(API_BASE + "/oauth/access_token", {
            method: "POST",
            headers,
            body: form.toString(),
            redirect: "manual"
        });

        // 4) Devuelve tal cual
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        const buf = Buffer.from(await resp.arrayBuffer());
        res.status(resp.status).send(buf);
    } catch (err) {
        res.status(502).json({ error: "proxy_token_error", detail: String(err) });
    }
});

// -------- Authorize: normaliza y REDIRIGE (no proxyear UI) --------
app.all("/oauth/authorize", (req, res) => {
    const u = new URL(req.url, PROXY_ORIGIN);
    ensureAuthorizeParams(u);
    const target = `${APP_BASE}${u.pathname}?${u.searchParams.toString()}`;
    return res.redirect(302, target);
});

// -------- Web → redirección; API (/v2/...) → proxy --------
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
// ---- GPT shim: POST /gpt/spotrates/patch  ->  PATCH /v2/spotrates (array body) ----
app.post("/gpt/spotrates/patch", async (req, res) => {
    try {
        const headers = {
            ...cloneHeaders(req),
            "Content-Type": "application/json",
            "Accept": "application/json"
        };
        // body esperado desde GPT: { "items": [ { property_id, date, amount, ... }, ... ] }
        const raw = req.body ? req.body.toString("utf8") : "";
        let items = [];
        try {
            const obj = raw ? JSON.parse(raw) : {};
            items = Array.isArray(obj?.items) ? obj.items : [];
        } catch { /* ignore */ }

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "invalid_body", hint: "Expected { items: SpotRatePatch[] }" });
        }

        const resp = await fetch(API_BASE + "/v2/spotrates", {
            method: "PATCH",
            headers,
            body: JSON.stringify(items),
            redirect: "manual"
        });
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        const buf = Buffer.from(await resp.arrayBuffer());
        res.status(resp.status).send(buf);
    } catch (err) {
        res.status(502).json({ error: "spotrates_shim_error", detail: String(err) });
    }
});

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
