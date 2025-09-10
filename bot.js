// bot.js — VVV watcher + tweet (Twitter v2 via OAuth 1.0a; no deps)

import crypto from "node:crypto";

// ---------- ENV ----------
const env = (k, d = "") => (process.env[k] ?? d).toString().trim();

const API_URL = env("API_URL", "https://www.vvv.so/api/get-top-collections");
const TEXT_TEMPLATE="🚨 New NFT Drop 🚨\n\n✨ Name: %%NAME%%\n✨ Supply: %%SIZE%%\n✨ Link: %%URL%%";
const MAX_TWEETS_PER_RUN = Number(env("MAX_TWEETS_PER_RUN", "3")) || 3;
const INCLUDE_COMING_SOON = /^true$/i.test(env("INCLUDE_COMING_SOON", "false"));

const GIST_ID = env("GIST_ID");
const GIST_TOKEN = env("GIST_TOKEN");

const X_KEYS = {
  consumerKey: env("X_API_KEY"),
  consumerSecret: env("X_API_SECRET"),
  accessToken: env("X_ACCESS_TOKEN"),
  accessSecret: env("X_ACCESS_SECRET"),
};

// ---------- SMALL UTILS ----------
const enc = (s = "") =>
  encodeURIComponent(s).replace(/[!*()']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function truncateTweet(s, limit = 280) {
  if (s.length <= limit) return s;
  return s.slice(0, limit - 1).trimEnd() + "…";
}

// Build OAuth 1.0a Authorization header (HMAC-SHA1)
function oauthHeader({ method, url, consumerKey, consumerSecret, accessToken, accessSecret }) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  // Base string params: query + oauth (JSON body is NOT included)
  const params = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  Object.assign(params, oauth);

  const paramStr = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join("&");

  const base = [method.toUpperCase(), enc(u.origin + u.pathname), enc(paramStr)].join("&");
  const signingKey = `${enc(consumerSecret)}&${enc(accessSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");

  oauth.oauth_signature = signature;

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${enc(k)}="${enc(oauth[k])}"`)
      .join(", ")
  );
}

// ---------- TWITTER HELPERS (v2 tweeting, v1.1 verify) ----------
const TW_V1_VERIFY = "https://api.twitter.com/1.1/account/verify_credentials.json";
const TW_V2_TWEETS = "https://api.twitter.com/2/tweets";

async function verifyAuth() {
  const auth = oauthHeader({ method: "GET", url: TW_V1_VERIFY, ...X_KEYS });
  const r = await fetch(TW_V1_VERIFY, { headers: { Authorization: auth } });
  const body = await r.text();
  if (!r.ok) throw new Error(`verify failed ${r.status}: ${body}`);
  console.log("auth ok; access-level:", r.headers.get("x-access-level") || "unknown");
}

async function postTweet(text) {
  const auth = oauthHeader({ method: "POST", url: TW_V2_TWEETS, ...X_KEYS });
  const r = await fetch(TW_V2_TWEETS, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`tweet failed ${r.status}: ${t}`);
  const j = JSON.parse(t);
  return j?.data?.id;
}

// ---------- GIST STATE (known IDs) ----------
const GIST_FILE = "state.json";

async function loadKnownIds() {
  if (!GIST_ID || !GIST_TOKEN) return new Set();
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `token ${GIST_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`gist read failed ${r.status}`);
  const j = await r.json();
  const file = j.files?.[GIST_FILE];
  if (!file || !file.content) return new Set();
  try {
    const arr = JSON.parse(file.content);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function saveKnownIds(idsSet) {
  if (!GIST_ID || !GIST_TOKEN) return;
  const content = JSON.stringify([...idsSet], null, 0);
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `token ${GIST_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files: { [GIST_FILE]: { content } } }),
  });
  if (!r.ok) throw new Error(`gist write failed ${r.status}`);
}

// ---------- VVV FETCH + NORMALIZE ----------
function vvvUrl(col) {
  if (col.slug) return `https://www.vvv.so/${col.slug}`;
  if (col.external_url) return col.external_url;
  return "https://www.vvv.so/";
}

function normalize(col) {
  const id = col.slug || col.collection_nft_pub_key || col.name || crypto.randomUUID();
  return {
    id: String(id),
    slug: col.slug ?? "",
    name: col.name ?? "",
    size: col.collection_size ?? "",
    img: col.collection_image_url ?? "",
    pubkey: col.collection_nft_pub_key ?? "",
    url: vvvUrl(col),
    comingSoon: !!col.coming_soon,
    raw: col,
  };
}

function formatText(tpl, col) {
  const map = {
    "%%NAME%%": col.name ?? "",
    "%%SIZE%%": col.size ?? "",
    "%%URL%%": col.url ?? "",
    "%%IMG%%": col.img ?? "",
    "%%PUBKEY%%": col.pubkey ?? "",
    "%%SLUG%%": col.slug ?? "",
  };
  return Object.entries(map).reduce((s, [k, v]) => s.replaceAll(k, String(v)), tpl);
}

async function fetchCollections() {
  const r = await fetch(API_URL, { headers: { "User-Agent": "vvv-watcher-bot" } });
  const j = await r.json();
  if (!r.ok || !j?.collections) throw new Error(`fetch failed ${r.status}`);
  const arr = j.collections.map(normalize);
  return INCLUDE_COMING_SOON ? arr : arr.filter((c) => !c.comingSoon);
}

// ---------- MAIN ----------
async function main() {
  // Basic sanity
  for (const [k, v] of Object.entries(X_KEYS)) {
    if (!v) throw new Error(`missing Twitter secret: ${k}`);
  }
  if (!GIST_ID || !GIST_TOKEN) {
    console.warn("⚠️  No Gist state configured (GIST_ID / GIST_TOKEN). Bot will not remember IDs.");
  }

  // Verify auth (also prints x-access-level header)
  await verifyAuth();

  const cols = await fetchCollections();
  const currentIds = new Set(cols.map((c) => c.id));

  const known = await loadKnownIds();
  const firstRun = known.size === 0;

  if (firstRun) {
    // Seed state, don't tweet
    for (const id of currentIds) known.add(id);
    await saveKnownIds(known);
    console.log(`Seeded ${currentIds.size} ids on first run; not tweeting.`);
    return { seeded: currentIds.size, posted: 0 };
  }

  // Diff
  const fresh = cols.filter((c) => !known.has(c.id));
  if (fresh.length === 0) {
    console.log("No new collections");
    return { posted: 0, note: "No new collections" };
  }

  const toPost = fresh.slice(0, MAX_TWEETS_PER_RUN);
  let posted = 0;

  for (const col of toPost) {
    let text = formatText(TEXT_TEMPLATE, col);
    text = truncateTweet(text, 280);

    try {
      const id = await postTweet(text);
      posted += 1;
      console.log(`tweeted ${id}: ${text}`);
      // Gentle gap to avoid rate spikes
      await sleep(800);
    } catch (err) {
      console.error("tweet error:", err?.message || err);
    }
  }

  // Update known ids (union with current)
  const union = new Set([...known, ...currentIds]);
  await saveKnownIds(union);

  return { posted, queued: fresh.length, keptKnown: union.size };
}

// Run
main()
  .then((res) => {
    console.log(JSON.stringify(res, null, 2));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
