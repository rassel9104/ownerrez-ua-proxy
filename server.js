// server.js
import express from "express";
import { URL } from "url";

const app = express();

// ------------ CONFIG ------------
const PROXY_ORIGIN = "https://ownerrez-ua-proxy.onrender.com";
const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";
const FALLBACK_CLIENT_ID = process.env.OWNERREZ_CLIENT_ID || "c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g";
const FALLBACK_REDIRECT =
    process.env.GPT_REDIRECT_URI ||
    "https://chat.openai.com/aip/g-4c7fcb8735f81f7eda9337dc66fdc10c530695c2/oauth/callback";

const APP_BASE = "https://app.ownerrez.com";
const API_BASE = "https://api.ownerrez.com";

// ------------ UTILS ------------
app.get("/__health", (req, res) => res.json({ ok: true }));
app.use(express.raw({ type: () => true, limit: "10mb" }));

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

function isWebPath(pathname) {
    return (
        pathname.startsWith("/oauth/") ||
        pathname === "/oauth" ||
        pathname.startsWith("/login") ||
        pathname.startsWith("/signin") ||
        pathname.startsWith("/account") ||
        pathname.startsWith("/identity") ||
        pathname === "/"
    );
}

function ensureAuthorizeParams(u) {
    const q = u.searchParams;
    if (!q.get("client_id") || q.get("client_id").trim() === "") q.set("client_id", FALLBACK_CLIENT_ID);
    if (!q.get("redirect_uri") || q.get("redirect_uri").trim() === "") q.set("redirect_uri", FALLBACK_REDIRECT);
    if (!q.get("response_type")) q.set("response_type", "code");
}

function toProxyOrigin(absUrl) {
    const u = new URL(absUrl);
    const p = new URL(PROXY_ORIGIN);
    u.protocol = p.protocol;
    u.host = p.host;
    return u.toString();
}

function rewriteSetCookie(setCookieHeaders) {
    if (!setCookieHeaders) return null;
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const proxyHost = new URL(PROXY_ORIGIN).host;
    return arr.map((sc) => {
        let out = sc.replace(/;\s*Domain=\.?ownerrez\.com/gi, `; Domain=${proxyHost}`);
        if (!/;\s*SameSite=/i.test(out)) out += "; SameSite=None";
        if (!/;\s*Secure/i.test(out)) out += "; Secure";
        return out;
    });
}

async function pass(req, res, targetBase) {
    const targetUrl = targetBase + req.originalUrl;
    const init = {
        method: req.method,
        headers: cloneHeaders(req),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual"
    };

    const resp = await fetch(targetUrl, init);

    // Copiamos headers mutables
    const respHeaders = new Headers(resp.headers);

    // (A) Interceptar 302/303 con Location → /login?returnUrl=oauth/authorize?... y reescribirla
    const status = resp.status;
    const rawLoc = respHeaders.get("location");
    if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && rawLoc) {
        // Normaliza la Location al dominio del proxy
        let loc = rawLoc;
        try {
            // si es absoluta de app/api -> cámbiala a proxy
            const abs = new URL(rawLoc, APP_BASE);
            if (abs.origin === APP_BASE || abs.origin === API_BASE) {
                loc = toProxyOrigin(abs.toString());
            }
        } catch { /* noop */ }

        // ¿Apunta a /login con returnUrl=oauth/authorize... ?
        const locUrl = new URL(loc, PROXY_ORIGIN);
        if (locUrl.pathname === "/login") {
            const ru = locUrl.searchParams.get("returnUrl") || "";
            if (ru) {
                const inner = new URL(ru.startsWith("/") ? `${PROXY_ORIGIN}${ru}` : `${PROXY_ORIGIN}/${ru}`);
                if (inner.pathname === "/oauth/authorize") {
                    ensureAuthorizeParams(inner);
                    // Redirige directamente a /oauth/authorize corregido bajo el PROXY
                    const fixed = `${inner.pathname}?${inner.searchParams.toString()}`;
                    respHeaders.set("location", fixed); // relativa al proxy
                }
            }
        } else if (locUrl.pathname === "/oauth/authorize") {
            // También aseguramos params si redirige directo a authorize
            ensureAuthorizeParams(locUrl);
            respHeaders.set("location", `${locUrl.pathname}?${locUrl.searchParams.toString()}`);
        }
    }

    // (B) Reescribir Set-Cookie -> dominio del proxy
    const setCookies = resp.headers.getSetCookie?.() || respHeaders.get("set-cookie");
    const rewritten = rewriteSetCookie(setCookies);
    if (rewritten) {
        respHeaders.delete("set-cookie");
        (Array.isArray(rewritten) ? rewritten : [rewritten]).forEach((c) => res.append("set-cookie", c));
    }

    // (C) Pasar el resto de headers (evita duplicar set-cookie)
    for (const [k, v] of respHeaders.entries()) {
        if (k.toLowerCase() !== "set-cookie") res.setHeader(k, v);
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
}

// ------------ RUTAS ------------
app.all("/oauth/access_token", (req, res) => pass(req, res, API_BASE));

app.all("/oauth/authorize", (req, res) => {
    const u = new URL(req.url, PROXY_ORIGIN);
    ensureAuthorizeParams(u);
    req.url = `${u.pathname}?${u.searchParams.toString()}`;
    return pass(req, res, APP_BASE);
});

app.use((req, res) => {
    const pathname = new URL(req.url, PROXY_ORIGIN).pathname;
    return isWebPath(pathname) ? pass(req, res, APP_BASE) : pass(req, res, API_BASE);
});

// ------------ START ------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("UA proxy listening on", PORT));
