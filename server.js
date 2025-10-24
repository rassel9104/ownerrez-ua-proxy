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

// -------- Token: fuerza Basic y body form con client creds --------
app.all("/oauth/access_token", async (req, res) => {
    const targetUrl = API_BASE + req.originalUrl;

    // 1) Cabeceras base + UA
    const headers = cloneHeaders(req);

    // 2) Content-Type correcto
    const ctKey = Object.keys(headers).find(k => k.toLowerCase() === "content-type");
    if (!ctKey) headers["Content-Type"] = "application/x-www-form-urlencoded";

    // 3) Authorization: Basic <client_id:client_secret> (siempre, sobreescribe)
    if (!CLIENT_SECRET) {
        return res.status(500).json({ error: "OWNERREZ_CLIENT_SECRET not configured" });
    }
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;

    // 4) Body: asegurar que incluya client_id, client_secret y redirect_uri (además del code/grant_type)
    let bodyOut;
    const isGetOrHead = req.method === "GET" || req.method === "HEAD";
    if (!isGetOrHead) {
        const incomingCT = (ctKey ? headers[ctKey] : "").toLowerCase();

        if (incomingCT.includes("application/x-www-form-urlencoded")) {
            const raw = req.body ? req.body.toString("utf8") : "";
            const params = new URLSearchParams(raw || "");
            if (!params.get("client_id")) params.set("client_id", CLIENT_ID);
            if (!params.get("client_secret")) params.set("client_secret", CLIENT_SECRET);
            if (!params.get("redirect_uri")) params.set("redirect_uri", REDIRECT_URI);
            // Asegura grant_type/code si por alguna razón faltaran (GPTBuilder los pone, pero robustecemos)
            if (!params.get("grant_type")) params.set("grant_type", "authorization_code");
            bodyOut = params.toString();
        } else {
            // Si no es form-urlencoded, transformamos a form
            const params = new URLSearchParams();
            params.set("grant_type", "authorization_code");
            // No tenemos el code aquí si GPT no lo mandó en body; mantenemos pass-through si vino en body binario
            // Para máxima compatibilidad, reenviamos el body original si existe:
            if (req.body && req.body.length > 0) {
                bodyOut = req.body; // deja pasar (pero con Basic header ya correcto)
            } else {
                // En caso extremo, mandamos sólo los creds (OwnerRez rechazará si no hay code, pero al menos creds correctos)
                params.set("client_id", CLIENT_ID);
                params.set("client_secret", CLIENT_SECRET);
                params.set("redirect_uri", REDIRECT_URI);
                bodyOut = params.toString();
                headers["Content-Type"] = "application/x-www-form-urlencoded";
            }
        }
    }

    const init = {
        method: req.method,
        headers,
        body: isGetOrHead ? undefined : bodyOut,
        redirect: "manual"
    };

    const resp = await fetch(targetUrl, init);
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
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
