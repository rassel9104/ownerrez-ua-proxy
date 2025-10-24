const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_BASE = "https://api.ownerrez.com";

// Ruta de salud
app.get("/__health", (req, res) => {
    res.status(200).json({ ok: true });
});

// Acepta cualquier tipo de body
app.use(express.raw({ type: "*/*", limit: "10mb" }));

// Proxy: inyecta User-Agent
app.all("/*", async (req, res) => {
    try {
        // Reemplazamos el * con la ruta completa
        const targetUrl = TARGET_BASE + req.originalUrl;

        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
            const lk = k.toLowerCase();
            if (lk === "host" || lk === "content-length" || lk === "user-agent") continue;
            headers[k] = v;
        }
        // Sustituye 'c_TU_CLIENT_ID' por tu client_id real
        headers["User-Agent"] = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";

        const hasBody = !(req.method === "GET" || req.method === "HEAD");
        const init = {
            method: req.method,
            headers,
            body: hasBody ? req.body : undefined,
            redirect: "follow"
        };

        const resp = await fetch(targetUrl, init);

        for (const [k, v] of resp.headers.entries()) {
            try { res.setHeader(k, v); } catch (e) { }
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        res.status(resp.status).send(buf);
    } catch (err) {
        res.status(502).json({ error: "Proxy error", detail: String(err) });
    }
});

app.listen(PORT, () => {
    console.log("UA proxy listening on port", PORT);
});
