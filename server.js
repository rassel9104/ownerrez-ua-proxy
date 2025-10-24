// server.js
import express from "express";
import { URL } from "url";

const app = express();

// --- Config obligatoria ---
const PROXY_ORIGIN = "https://ownerrez-ua-proxy.onrender.com";
const APP_BASE = "https://app.ownerrez.com";
const API_BASE = "https://api.ownerrez.com";

const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";

const CLIENT_ID = process.env.OWNERREZ_CLIENT_ID || "c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g";
const CLIENT_SECRET = process.env.OWNERREZ_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.GPT_REDIRECT_URI; // sin fallback: tu GPT real

// Validaciones tempranas
if (!CLIENT_SECRET) throw new Error("OWNERREZ_CLIENT_SECRET not configured");
if (!REDIRECT_URI) throw new Error("GPT_REDIRECT_URI not configured (https://chatgpt.com/aip/g-.../oauth/callback)");
if (!/^https:\/\/chatgpt\.com\/aip\/g-[a-f0-9]+\/oauth\/callback$/i.test(REDIRECT_URI)) {
    console.warn("WARN: GPT_REDIRECT_URI no parece de chatgpt.com; revísalo:", REDIRECT_URI);
}

// Salud
app.get("/__health", (req, res) => res.json({ ok: true }));

// Acepta cualquier body (token usa x-www-form-urlencoded; shim usa JSON)
app.use(express.raw({ type: () => true, limit: "10mb" }));

// ---- Utils ----
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

async function proxyGeneric(req, res, targetBase) {
    const targetUrl = targetBase + req.originalUrl;
    const init = {
        method: req.method,
        headers: cloneHeaders(req),
        body: (req.method === "GET" || req.method === "HEAD") ? undefined : req.body,
        redirect: "manual"
    };
    const resp = await fetch(targetUrl, init);
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
}

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

// ---- OAuth AUTHORIZE: fija siempre client_id + redirect_uri del GPT (chatgpt.com) ----
app.all("/oauth/authorize", (req, res) => {
    const u = new URL(req.url, PROXY_ORIGIN);
    const q = u.searchParams;

    q.set("client_id", CLIENT_ID);
    q.set("redirect_uri", REDIRECT_URI);
    if (!q.get("response_type")) q.set("response_type", "code");

    console.log("AUTHZ ▶︎", {
        client_id: q.get("client_id"),
        redirect_uri: q.get("redirect_uri"),
        state_len: (q.get("state") || "").length
    });

    const target = `${APP_BASE}${u.pathname}?${q.toString()}`;
    return res.redirect(302, target);
});

// ---- OAuth TOKEN: respeta code del cliente y fuerza redirect_uri = chatgpt.com si viene vacío o viejo ----
app.all("/oauth/access_token", async (req, res) => {
    try {
        const headers = {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "Authorization": "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")
        };

        // Extraer parámetros del body/query
        const raw = req.body ? req.body.toString("utf8") : "";
        const inParams = new URLSearchParams(raw || "");
        let code = inParams.get("code");
        let redirect_uri = inParams.get("redirect_uri");

        if (!code) {
            const u = new URL(req.url, PROXY_ORIGIN);
            code = u.searchParams.get("code") || "";
        }
        if (!redirect_uri) {
            const u = new URL(req.url, PROXY_ORIGIN);
            redirect_uri = u.searchParams.get("redirect_uri") || "";
        }

        // Si falta o el dominio es el antiguo, usa el de env (chatgpt.com)
        if (!redirect_uri || /chat\.openai\.com/i.test(redirect_uri)) {
            redirect_uri = REDIRECT_URI;
        }

        console.log("TOKEN ▶︎", { has_code: !!code, redirect_uri });

        if (!code) return res.status(400).json({ error: "missing_authorization_code" });
        if (!redirect_uri) return res.status(400).json({ error: "missing_redirect_uri" });

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

        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        const buf = Buffer.from(await resp.arrayBuffer());
        res.status(resp.status).send(buf);
    } catch (err) {
        console.error("TOKEN ERROR ▶︎", err);
        res.status(502).json({ error: "proxy_token_error", detail: String(err) });
    }
});

// ---- GPT shim: POST /gpt/spotrates/patch -> PATCH /v2/spotrates (array body) ----
app.post("/gpt/spotrates/patch", async (req, res) => {
    try {
        const headers = {
            ...cloneHeaders(req),
            "Content-Type": "application/json",
            "Accept": "application/json"
        };
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
        console.error("SPOTRATES SHIM ERROR ▶︎", err);
        res.status(502).json({ error: "spotrates_shim_error", detail: String(err) });
    }
});

// ---- Enrutamiento final: UI a APP; API a API ----
app.use((req, res) => {
    const pathname = new URL(req.url, PROXY_ORIGIN).pathname;
    if (isWebPath(pathname)) {
        const target = APP_BASE + req.originalUrl;
        return res.redirect(302, target);
    }
    return proxyGeneric(req, res, API_BASE);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("UA proxy listening on", PORT));
