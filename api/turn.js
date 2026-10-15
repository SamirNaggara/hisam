// Identifiants TURN temporaires (Cloudflare), pour relayer l'audio quand deux
// navigateurs ne peuvent pas se joindre directement (NAT, 4G, reseau d'entreprise).
// La cle reste cote serveur : le navigateur ne recoit que des identifiants de 24h.
// Variables Vercel : CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN.
const TTL_SECONDS = 24 * 3600;

module.exports = async (req, res) => {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  res.setHeader("Cache-Control", "no-store");
  if (!keyId || !token) {
    res.status(503).json({ error: "TURN non configure" });
    return;
  }
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      }
    );
    if (!r.ok) {
      res.status(502).json({ error: `Cloudflare a repondu ${r.status}` });
      return;
    }
    const { iceServers } = await r.json();
    res.status(200).json({ iceServers: [].concat(iceServers), ttl: TTL_SECONDS });
  } catch (err) {
    res.status(502).json({ error: "Cloudflare injoignable" });
  }
};
