// Node 20+ (Actions runner has it). No external deps.

const crypto = await import("node:crypto");
const API_URL = process.env.API_URL || "https://www.vvv.so/api/get-top-collections";
const TEXT_TEMPLATE = process.env.TEXT_TEMPLATE || "New VVV collection: %%NAME%% — %%URL%% #Solana #NFTs";
const MAX_TWEETS_PER_RUN = parseInt(process.env.MAX_TWEETS_PER_RUN || "3", 10);
const INCLUDE_COMING_SOON = (process.env.INCLUDE_COMING_SOON || "false") === "true";

// --- OAuth1 for Twitter v1.1 statuses/update.json ---
const enc = (s) =>
  encodeURIComponent(s).replace(/[!*()']/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function oauthHeader({ method, url, consumerKey, consumerSecret, token, tokenSecret, formParams = {} }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const baseParams = { ...oauth, ...formParams };
  const norm = Object.keys(baseParams)
    .sort()
    .map((k) => `${enc(k)}=${enc(baseParams[k])}`)
    .join("&");
  const baseString = [method.toUpperCase(), enc(url), enc(norm)].join("&");
  const signingKey = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  const auth = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.keys(auth).sort().map((k) => `${enc(k)}="${enc(auth[k])}"`).join(", ");
}

async function postTweetV11(status) {
  const endpoint = "https://api.twitter.com/1.1/statuses/update.json";
  const form = { status };
  const headers = {
    Authorization: oauthHeader({
      method: "POST",
      url: endpoint,
      consumerKey: process.env.X_API_KEY,
      consumerSecret: process.env.X_API_SECRET,
      token: process.env.X_ACCESS_TOKEN,
      tokenSecret: process.env.X_ACCESS_SECRET,
      formParams: form,
    }),
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "User-Agent": "vvv-bot/1.0",
  };
  const body = new URLSearchParams(form).toString();
  const r = await fetch(endpoint, { method: "POST", headers, body });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`tweet failed ${r.status}: ${t}`);
  }
  const j = await r.json();
  return j?.id_str || j?.id;
}

const truncate = (s, max = 280) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

// --- Gist state helpers ---
async function readGistArray(gistId, filename, token) {
  const gh = "https://api.github.com";
  const meta = await fetch(`${gh}/gists/${gistId}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "vvv-bot" },
  });
  if (!meta.ok) throw new Error(`gist meta ${meta.status}`);
  const info = await meta.json();
  const rawUrl = info?.files?.[filename]?.raw_url;
  if (!rawUrl) return [];
  const fileRes = await fetch(rawUrl, { headers: { "User-Agent": "vvv-bot" } });
  if (!fileRes.ok) return [];
  try {
    return JSON.parse(await fileRes.text());
  } catch {
    return [];
  }
}

async function writeGistArray(gistId, filename, token, array) {
  const gh = "https://api.github.com";
  const body = {
    files: {
      [filename]: { content: JSON.stringify(array, null, 2) },
    },
  };
  const r = await fetch(`${gh}/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "vvv-bot",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`gist write ${r.status}: ${await r.text()}`);
}

function normalizeCollections(payload) {
  let list = Array.isArray(payload?.collections) ? payload.collections : [];
  if (!INCLUDE_COMING_SOON) list = list.filter((c) => !c.coming_soon);

  return list
    .map((c) => {
      const slug = c.slug || "";
      const id = slug || c.collection_nft_pub_key || c.name || "";
      if (!id) return null;
      return {
        id,
        name: (c.name || (slug ? slug.replace(/[-_]/g, " ") : "Unknown")).trim(),
        size: c.collection_size ?? "",
        img: c.collection_image_url ?? "",
        pubkey: c.collection_nft_pub_key ?? "",
        slug,
        url: slug ? `https://www.vvv.so/collection/${slug}` : (c.external_url || "https://www.vvv.so/"),
      };
    })
    .filter(Boolean);
}

function render(template, row) {
  return template
    .replaceAll("%%NAME%%", row.name)
    .replaceAll("%%SIZE%%", String(row.size ?? ""))
    .replaceAll("%%IMG%%", row.img)
    .replaceAll("%%PUBKEY%%", row.pubkey)
    .replaceAll("%%SLUG%%", row.slug)
    .replaceAll("%%URL%%", row.url);
}

// ---- main ----
(async () => {
  for (const k of ["GIST_ID", "GIST_TOKEN", "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) {
    if (!process.env[k]) throw new Error(`Missing env: ${k}`);
  }

  const res = await fetch(API_URL, { headers: { accept: "application/json", "User-Agent": "vvv-bot" } });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const payload = await res.json();

  const rows = normalizeCollections(payload);
  const currentIds = rows.map((r) => r.id);

  const filename = "vvv-known-ids.json";
  let knownIds = await readGistArray(process.env.GIST_ID, filename, process.env.GIST_TOKEN);
  if (!Array.isArray(knownIds)) knownIds = [];

  const firstRun = knownIds.length === 0;
  const knownSet = new Set(knownIds);
  const fresh = rows.filter((r) => !knownSet.has(r.id));

  // persist union
  await writeGistArray(process.env.GIST_ID, filename, process.env.GIST_TOKEN, Array.from(new Set([...knownIds, ...currentIds])));

  if (firstRun) {
    console.log(`Seeded ${currentIds.length} ids on first run; not tweeting.`);
    return;
  }
  const toPost = fresh.slice(0, MAX_TWEETS_PER_RUN);
  if (!toPost.length) {
    console.log("No new collections");
    return;
  }

  for (const r of toPost) {
    const text = truncate(render(TEXT_TEMPLATE, r), 280);
    const id = await postTweetV11(text);
    console.log(`Tweeted (${id}): ${text}`);
  }
})();
