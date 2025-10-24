// server.js
const express = require("express");
const app = express();
const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";

app.get("/__health", (req, res) => res.json({ ok: true }));

// Acepta cualquier tipo de body (incluye x-www-form-urlencoded del token endpoint)
app.use(express.raw({ type: "*/*", limit: "10mb" }));

async function forward(req, res, targetBase) {
    const targetUrl = targetBase + req.originalUrl;
    const headers = {};

    // Copia headers entrantes, excepto host/content-length/user-agent
    for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "content-length" || lk === "user-agent") continue;
        headers[k] = v;
    }
    headers["User-Agent"] = UA;

    const init = {
        method: req.method,
        headers,
        body: (req.method === "GET" || req.method === "HEAD") ? undefined : req.body,
        redirect: "manual"
    };

    const resp = await fetch(targetUrl, init);

    // Pasa headers/respuesta tal cual
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
}

// Rutas OAuth:
app.all("/oauth/authorize", (req, res) => forward(req, res, "https://app.ownerrez.com"));
app.all("/oauth/access_token", (req, res) => forward(req, res, "https://api.ownerrez.com"));

// Resto de rutas (API v2 y demás):
app.all("*", (req, res) => forward(req, res, "https://api.ownerrez.com"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("UA proxy on", PORT));
