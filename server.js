
import "dotenv/config";
import { MongoClient } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";

// ============================================================
// CONFIGURATION
// ============================================================

const {
  TUBEARCHIVIST_URL,
  TUBEARCHIVIST_API_TOKEN,
  MONGODB_URI,
  MONGODB_DATABASE = "tubearchivist",
  MONGODB_COLLECTION = "jellyfin_sync",
  MEDIA_ROOT = "/youtube",
  CHECK_INTERVAL_MS = "1800000",
  OVERWRITE_NFO = "true",
  DRY_RUN = "true",
  VIDEO_EXTENSIONS = ".mp4,.mkv,.webm,.m4v,.mov",
  LOG_LEVEL = "info"
} = process.env;

const INTERVAL = Number(CHECK_INTERVAL_MS);
const OVERWRITE = OVERWRITE_NFO.toLowerCase() === "true";
const DRY = DRY_RUN.toLowerCase() === "true";
const ROOT = path.resolve(MEDIA_ROOT);

const EXTENSIONS = new Set(
  VIDEO_EXTENSIONS.split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean)
);

const LEVEL = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT_LEVEL = LEVEL[String(LOG_LEVEL).toLowerCase()] ?? 20;

if (!TUBEARCHIVIST_URL) throw new Error("Missing TUBEARCHIVIST_URL in .env");
if (!TUBEARCHIVIST_API_TOKEN) throw new Error("Missing TUBEARCHIVIST_API_TOKEN in .env");
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");

if (!Number.isFinite(INTERVAL) || INTERVAL < 1000) {
  throw new Error("CHECK_INTERVAL_MS must be at least 1000");
}

const client = new MongoClient(MONGODB_URI);

let collection;
let stopping = false;
let running = false;
let wakeSleep;

// Legacy fields no longer needed by this workflow.
const OBSOLETE_FIELDS = {
  title: "",
  channelId: "",
  channelName: "",
  published: "",
  updatedAt: "",
  createdAt: "",
  jellyfinId: "",
  jellyfinSynced: ""
};

// ============================================================
// LOGGING
// ============================================================

function log(level, message, extra) {
  if ((LEVEL[level] ?? 20) < CURRENT_LEVEL) return;

  const prefix =
    `[${new Date().toISOString()}] [${level.toUpperCase()}]`;

  if (extra === undefined) {
    console.log(prefix, message);
  } else {
    console.log(prefix, message, extra);
  }
}

// ============================================================
// PATH AND ID HELPERS
// ============================================================

function validId(id) {
  return typeof id === "string" &&
    /^[A-Za-z0-9_-]{11}$/.test(id);
}

function relativeMediaPath(filePath) {
  return path.relative(ROOT, filePath)
    .split(path.sep)
    .join("/");
}

function absoluteMediaPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath) {
    return null;
  }

  const resolved = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, resolved);

  // Prevent paths from escaping MEDIA_ROOT.
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  return resolved;
}

async function isFile(filePath) {
  try {
    return Boolean(filePath) &&
      (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

// ============================================================
// TUBEARCHIVIST API
// ============================================================

async function tubeRequest(endpoint) {
  const base = TUBEARCHIVIST_URL.replace(/\/$/, "");
  const apiPath = endpoint.replace(/^\//, "");

  const response = await fetch(
    `${base}/api/${apiPath}`,
    {
      headers: {
        Authorization: `Token ${TUBEARCHIVIST_API_TOKEN}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(60000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `TubeArchivist API ${response.status}: ` +
      await response.text()
    );
  }

  return response.json();
}

function unpackPage(data) {
  if (Array.isArray(data)) {
    return { batch: data, pagination: null };
  }

  if (Array.isArray(data?.data)) {
    return {
      batch: data.data,
      pagination: data.paginate ?? null
    };
  }

  if (Array.isArray(data?.results)) {
    return {
      batch: data.results,
      pagination: data.pagination ?? data.paginate ?? null
    };
  }

  if (Array.isArray(data?.items)) {
    return {
      batch: data.items,
      pagination: data.pagination ?? data.paginate ?? null
    };
  }

  throw new Error(
    "Unexpected TubeArchivist video-list response format"
  );
}

// ============================================================
// GET TUBEARCHIVIST VIDEO LIST
// ============================================================

async function getVideos() {
  const byId = new Map();
  const visited = new Set();

  let page = 0;
  let expectedTotal = null;

  while (!stopping) {
    if (visited.has(page)) break;

    visited.add(page);

    log("debug", `Fetching TubeArchivist page ${page}`);

    const data = await tubeRequest(`video/?page=${page}`);
    const { batch, pagination } = unpackPage(data);

    if (pagination) {
      const total = Number(pagination.total_hits);

      if (Number.isFinite(total) && total >= 0) {
        expectedTotal = total;
      }
    }

    if (!batch.length) break;

    let newCount = 0;

    for (const video of batch) {
      const id = video.youtube_id || video.id;

      if (!validId(id)) continue;

      if (!byId.has(id)) newCount++;

      byId.set(id, video);
    }

    log(
      "info",
      `Page ${page}: returned=${batch.length}, ` +
      `new=${newCount}, unique=${byId.size}`
    );

    const nextPages = Array.isArray(pagination?.next_pages)
      ? pagination.next_pages.map(Number).filter(Number.isFinite)
      : [];

    if (nextPages.length) {
      const next = nextPages.find(n => !visited.has(n));

      if (next === undefined) break;

      page = next;
      continue;
    }

    const last = Number(pagination?.last_page);

    if (Number.isFinite(last) && last >= 0) {
      if (page >= last) break;

      page++;
      continue;
    }

    if (
      newCount === 0 ||
      (expectedTotal !== null && byId.size >= expectedTotal)
    ) {
      break;
    }

    page++;
  }

  log("info", `TubeArchivist video IDs collected: ${byId.size}`);

  if (
    expectedTotal !== null &&
    byId.size < expectedTotal
  ) {
    log(
      "warn",
      `API reports ${expectedTotal} videos; collected ${byId.size}. ` +
      "Check pagination."
    );
  }

  return [...byId.values()];
}

// ============================================================
// NORMALIZE DOWNLOAD TIMESTAMP
// ============================================================

function normalize(video) {
  const youtubeId = video.youtube_id || video.id;
  const raw = video.date_downloaded;

  if (
    !validId(youtubeId) ||
    raw === null ||
    raw === undefined ||
    raw === ""
  ) {
    return null;
  }

  const dateDownloaded = Number(raw);
  const downloadedAt = new Date(dateDownloaded * 1000);

  if (
    !Number.isFinite(dateDownloaded) ||
    dateDownloaded <= 0 ||
    Number.isNaN(downloadedAt.getTime())
  ) {
    return null;
  }

  return {
    youtubeId,
    dateDownloaded,
    downloadedAt
  };
}

// ============================================================
// SYNC NEW OR INCOMPLETE MONGODB RECORDS
// ============================================================

async function syncNewRecords() {
  log(
    "info",
    "Fetching TubeArchivist list and checking timestamps..."
  );

  const videos = await getVideos();

  let details = 0;
  let saved = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of videos) {
    if (stopping) break;

    const id = item.youtube_id || item.id;

    if (!validId(id)) {
      skipped++;
      continue;
    }

    const existing = await collection.findOne(
      { youtubeId: id },
      {
        projection: {
          _id: 1,
          dateDownloaded: 1,
          downloadedAt: 1
        }
      }
    );

    const hasTimestamp = existing &&
      (
        existing.downloadedAt != null ||
        existing.dateDownloaded != null
      );

    if (hasTimestamp) {
      log(
        "debug",
        `Timestamp already stored for ${id}; skipping detail request.`
      );
      continue;
    }

    try {
      log("info", `Fetching full metadata for ${id}`);

      const full = await tubeRequest(
        `video/${encodeURIComponent(id)}/`
      );

      details++;

      const normalized = normalize(full);

      if (!normalized) {
        log(
          "warn",
          `${id}: date_downloaded missing or invalid; retrying later.`
        );
        skipped++;
        continue;
      }

      await collection.updateOne(
        { youtubeId: id },
        {
          $set: {
            dateDownloaded: normalized.dateDownloaded,
            downloadedAt: normalized.downloadedAt
          },
          $setOnInsert: {
            youtubeId: id,
            nfoProcessed: false,
            createdAt: new Date()
          }
        },
        { upsert: true }
      );

      saved++;

      log(
        "info",
        `Stored timestamp for ${id}: ` +
        normalized.downloadedAt.toISOString()
      );
    } catch (error) {
      failed++;
      log("error", `Timestamp sync failed for ${id}: ${error.message}`);
    }
  }

  log("info", "Timestamp sync summary", {
    listCount: videos.length,
    detailRequests: details,
    saved,
    skipped,
    failed
  });
}

// ============================================================
// FIND YOUTUBE ID IN FILENAME OR INFO.JSON
// ============================================================

function extractId(filename) {
  const stem = path.parse(filename).name;

  if (validId(stem)) return stem;

  const matches = [
    ...stem.matchAll(/\[([A-Za-z0-9_-]{11})\]/g)
  ];

  return matches.length === 1 ? matches[0][1] : null;
}

async function idFromInfo(infoPath) {
  try {
    const info = JSON.parse(
      await fs.readFile(infoPath, "utf8")
    );

    const id = info.id || info.youtube_id || info.youtubeId;

    return validId(id) ? id : null;
  } catch {
    return null;
  }
}

// ============================================================
// SEARCH ONLY FOR VIDEOS THAT NEED A PATH
// ============================================================

async function locateVideos(requested) {
  const found = new Map();

  if (!requested.size) return found;

  let directories = 0;
  let videoFiles = 0;

  log(
    "info",
    `Searching media tree for ${requested.size} video(s) needing paths.`
  );

  async function walk(directory) {
    if (stopping || found.size >= requested.size) return;

    let entries;

    try {
      entries = await fs.readdir(
        directory,
        { withFileTypes: true }
      );
    } catch (error) {
      log(
        "warn",
        `Cannot read directory ${directory}: ${error.message}`
      );
      return;
    }

    directories++;

    for (const entry of entries) {
      if (stopping || found.size >= requested.size) return;

      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();

      if (!EXTENSIONS.has(extension)) continue;

      videoFiles++;

      let id = extractId(entry.name);

      if (!id) {
        id = await idFromInfo(
          path.join(
            directory,
            `${path.parse(entry.name).name}.info.json`
          )
        );
      }

      if (
        id &&
        requested.has(id) &&
        !found.has(id)
      ) {
        found.set(id, fullPath);

        log(
          "info",
          `Located ${id}: ${relativeMediaPath(fullPath)}`
        );
      }
    }
  }

  await walk(ROOT);

  log("info", "Path search summary", {
    directories,
    videoFiles,
    found: found.size,
    requested: requested.size
  });

  return found;
}

// ============================================================
// NFO DATE AND XML HELPERS
// ============================================================

function dateFor(record) {
  if (record.downloadedAt instanceof Date) {
    return record.downloadedAt;
  }

  if (record.downloadedAt != null) {
    const date = new Date(record.downloadedAt);

    if (!Number.isNaN(date.getTime())) return date;
  }

  if (record.dateDownloaded != null) {
    const number = Number(record.dateDownloaded);

    const date = new Date(
      Math.abs(number) < 1e12
        ? number * 1000
        : number
    );

    if (!Number.isNaN(date.getTime())) return date;
  }

  return null;
}

function formatNfoDate(date) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createNfo(id, date) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>${xmlEscape(id)}</title>
  <dateadded>${formatNfoDate(date)}</dateadded>
  <uniqueid type="youtube" default="true">${id}</uniqueid>
</episodedetails>
`;
}

function updateNfo(xml, date) {
  const tag = `<dateadded>${formatNfoDate(date)}</dateadded>`;
  const pattern = /<dateadded\b[^>]*>[\s\S]*?<\/dateadded>/i;

  if (pattern.test(xml)) {
    return {
      ok: true,
      content: xml.replace(pattern, tag)
    };
  }

  const root = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>/.exec(xml);

  if (!root) {
    return {
      ok: false,
      reason: "Unrecognized XML root"
    };
  }

  const at = root.index + root[0].length;

  return {
    ok: true,
    content:
      xml.slice(0, at) +
      "\n  " +
      tag +
      xml.slice(at)
  };
}

// ============================================================
// PROCESS ONE VIDEO AND SAVE ITS PATHS
// ============================================================

async function processRecord(record, locatedPath = null) {
  const id = record.youtubeId;
  const date = dateFor(record);

  if (!validId(id) || !date) {
    log("warn", `Invalid ID/date for ${id}; leaving pending.`);
    return "invalid";
  }

  let media = absoluteMediaPath(record.mediaPath);

  if (media && await isFile(media)) {
    log("debug", `Using stored path for ${id}: ${record.mediaPath}`);
  } else {
    if (record.mediaPath) {
      log(
        "warn",
        `Stored path missing for ${id}: ${record.mediaPath}`
      );
    }

    media = locatedPath || null;
  }

  if (!media || !(await isFile(media))) {
    log(
      "warn",
      `Media not present locally for ${id}; retrying next cycle.`
    );
    return "missing-media";
  }

  const mediaPath = relativeMediaPath(media);

  const nfo = path.join(
    path.dirname(media),
    `${path.basename(media, path.extname(media))}.nfo`
  );

  const nfoPath = relativeMediaPath(nfo);

  let old = null;

  try {
    old = await fs.readFile(nfo, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let result;

  if (old !== null) {
    if (!OVERWRITE) {
      log("info", `Preserving existing NFO: ${nfoPath}`);
      result = "preserved";
    } else {
      const updated = updateNfo(old, date);

      if (!updated.ok) {
        log("warn", `Cannot safely edit ${nfoPath}: ${updated.reason}`);
        return "invalid-nfo";
      }

      if (updated.content === old) {
        log("debug", `NFO date already correct: ${nfoPath}`);
        result = "unchanged";
      } else if (DRY) {
        log(
          "info",
          `[DRY RUN] Would update ${nfoPath}; ` +
          `dateadded=${formatNfoDate(date)}`
        );
        result = "would-update";
      } else {
        await fs.writeFile(nfo, updated.content, "utf8");
        log("info", `Updated NFO: ${nfoPath}`);
        result = "updated";
      }
    }
  } else if (DRY) {
    log(
      "info",
      `[DRY RUN] Would create ${nfoPath}; ` +
      `dateadded=${formatNfoDate(date)}`
    );
    result = "would-create";
  } else {
    try {
      await fs.writeFile(
        nfo,
        createNfo(id, date),
        { encoding: "utf8", flag: "wx" }
      );

      log("info", `Created NFO: ${nfoPath}`);
      result = "created";
    } catch (error) {
      if (error.code === "EEXIST") {
        result = "preserved";
      } else {
        throw error;
      }
    }
  }

  // Store relative paths so host mount changes do not break the DB.
  const fields = {
    mediaPath,
    nfoPath,
    lastPathCheckAt: new Date()
  };

  const completed = [
    "preserved",
    "unchanged",
    "updated",
    "created"
  ].includes(result);

  if (!DRY && completed) {
    fields.nfoProcessed = true;
    fields.nfoProcessedAt = new Date();
    fields.nfoStatus = result;
  } else if (DRY) {
    fields.nfoProcessed = false;
    fields.nfoStatus = "dry-run";
  }

  await collection.updateOne(
    { youtubeId: id },
    { $set: fields }
  );

  return result;
}

// ============================================================
// PROCESS PENDING NFO RECORDS
// ============================================================

async function processPending() {
  log("info", "Querying MongoDB for pending NFO work...");

  const pending = await collection.find({
    youtubeId: { $exists: true, $ne: null },
    $and: [
      {
        $or: [
          { nfoProcessed: { $ne: true } },
          { mediaPath: { $exists: false } },
          { mediaPath: null }
        ]
      },
      {
        $or: [
          { downloadedAt: { $exists: true, $ne: null } },
          { dateDownloaded: { $exists: true, $ne: null } }
        ]
      }
    ]
  }).toArray();

  log("info", `Pending records found: ${pending.length}`);

  const requested = new Set();
  const usablePaths = new Map();

  for (const record of pending) {
    const stored = absoluteMediaPath(record.mediaPath);

    if (stored && await isFile(stored)) {
      usablePaths.set(record.youtubeId, stored);
    } else {
      requested.add(record.youtubeId);
    }
  }

  log(
    "info",
    `Stored paths valid=${usablePaths.size}; ` +
    `path lookup required=${requested.size}`
  );

  const located = await locateVideos(requested);

  const stats = {
    created: 0,
    updated: 0,
    preserved: 0,
    unchanged: 0,
    wouldCreate: 0,
    wouldUpdate: 0,
    missingMedia: 0,
    invalidNfo: 0,
    invalid: 0,
    failed: 0
  };

  const statMap = {
    created: "created",
    updated: "updated",
    preserved: "preserved",
    unchanged: "unchanged",
    "would-create": "wouldCreate",
    "would-update": "wouldUpdate",
    "missing-media": "missingMedia",
    "invalid-nfo": "invalidNfo",
    invalid: "invalid"
  };

  for (const record of pending) {
    if (stopping) break;

    try {
      log("info", `Processing video ${record.youtubeId}`);

      const result = await processRecord(
        record,
        usablePaths.get(record.youtubeId) ||
          located.get(record.youtubeId) ||
          null
      );

      if (statMap[result]) {
        stats[statMap[result]]++;
      }
    } catch (error) {
      stats.failed++;

      log(
        "error",
        `Failed ${record.youtubeId}: ${error.stack || error.message}`
      );
    }
  }

  log("info", "NFO processing summary", stats);
}

// ============================================================
// ONE COMPLETE CYCLE
// ============================================================

async function runCycle() {
  if (running) {
    log("warn", "Previous cycle still active; skipping overlap.");
    return;
  }

  running = true;

  log("info", "=================================================");
  log(
    "info",
    `Starting cycle; DRY_RUN=${DRY}; OVERWRITE_NFO=${OVERWRITE}`
  );

  try {
    // If TubeArchivist is unavailable, still process existing MongoDB work.
    try {
      await syncNewRecords();
    } catch (error) {
      log(
        "error",
        `TubeArchivist sync failed; continuing with MongoDB queue: ` +
        error.message
      );
    }

    if (!stopping) {
      await processPending();
    }
  } catch (error) {
    log("error", `Cycle failed: ${error.stack || error.message}`);
  } finally {
    running = false;
    log("info", `Cycle finished at ${new Date().toISOString()}`);
  }
}

// ============================================================
// PERIODIC RUNNER
// ============================================================

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);

    wakeSleep = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function main() {
  const rootStat = await fs.stat(ROOT).catch(() => null);

  if (!rootStat?.isDirectory()) {
    throw new Error(`MEDIA_ROOT is not an accessible directory: ${ROOT}`);
  }

  log("info", "Connecting to MongoDB...");

  await client.connect();

  collection = client
    .db(MONGODB_DATABASE)
    .collection(MONGODB_COLLECTION);

  await collection.createIndex(
    { youtubeId: 1 },
    { unique: true }
  );

  await collection.createIndex({ nfoProcessed: 1 });

  // Removes obsolete fields, but never deletes video records.
  const cleanup = await collection.updateMany(
    {},
    { $unset: OBSOLETE_FIELDS }
  );

  log(
    "info",
    `Removed obsolete fields from ${cleanup.modifiedCount} documents.`
  );

  log("info", `Database: ${MONGODB_DATABASE}.${MONGODB_COLLECTION}`);
  log("info", `Media root: ${ROOT}`);
  log("info", `Interval: ${INTERVAL} ms`);
  log("info", "Starting initial cycle.");

  while (!stopping) {
    await runCycle();

    if (stopping) break;

    log(
      "info",
      `Next cycle in ${INTERVAL} ms ` +
      `(${(INTERVAL / 60000).toFixed(1)} minutes).`
    );

    await sleep(INTERVAL);
  }
}

// ============================================================
// CLEAN SHUTDOWN
// ============================================================

async function shutdown(signal) {
  if (stopping) return;

  stopping = true;
  log("warn", `Received ${signal}; waiting for active work.`);

  if (wakeSleep) wakeSleep();

  while (running) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  await client.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch(async error => {
  log("error", `Fatal error: ${error.stack || error.message}`);
  await client.close().catch(() => {});
  process.exit(1);
});
