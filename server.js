
import "dotenv/config";
import { MongoClient } from "mongodb";

// ============================================================
// CONFIGURATION
// ============================================================

const {
    TUBEARCHIVIST_URL,
    TUBEARCHIVIST_API_TOKEN,
    MONGODB_URI,
    MONGODB_DATABASE = "tubearchivist",
    MONGODB_COLLECTION = "jellyfin_sync",
    CHECK_INTERVAL_MS = "300000",
} = process.env;

const CHECK_INTERVAL = Number(CHECK_INTERVAL_MS);

if (!TUBEARCHIVIST_URL) {
    throw new Error("Missing TUBEARCHIVIST_URL in .env");
}

if (!TUBEARCHIVIST_API_TOKEN) {
    throw new Error("Missing TUBEARCHIVIST_API_TOKEN in .env");
}

if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in .env");
}

if (!Number.isFinite(CHECK_INTERVAL) || CHECK_INTERVAL < 1000) {
    throw new Error("CHECK_INTERVAL_MS must be at least 1000");
}

// ============================================================
// MONGODB
// ============================================================

const mongoClient = new MongoClient(MONGODB_URI);

let collection;
let stopping = false;

// Fields no longer required by the NFO generator.
const OBSOLETE_FIELDS = {
    title: "",
    channelId: "",
    channelName: "",
    published: "",
    updatedAt: "",
    createdAt: "",
    jellyfinId: "",
    jellyfinSynced: "",
};

// ============================================================
// TUBEARCHIVIST API
// ============================================================

async function tubeArchivistRequest(endpoint) {
    const baseUrl = TUBEARCHIVIST_URL.replace(/\/$/, "");
    const apiPath = endpoint.replace(/^\//, "");

    const response = await fetch(
        `${baseUrl}/api/${apiPath}`,
        {
            method: "GET",
            headers: {
                Authorization: `Token ${TUBEARCHIVIST_API_TOKEN}`,
                Accept: "application/json",
            },
            signal: AbortSignal.timeout(60000),
        }
    );

    if (!response.ok) {
        const body = await response.text();

        throw new Error(
            `TubeArchivist API ${response.status}: ${body}`
        );
    }

    return response.json();
}

// ============================================================
// GET ALL VIDEOS
// Supports common TubeArchivist pagination formats.
// ============================================================

async function getTubeArchivistVideos() {
    const videosById = new Map();
    const visitedPages = new Set();

    let page = 0;
    let expectedTotal = null;

    while (true) {
        if (visitedPages.has(page)) {
            break;
        }

        visitedPages.add(page);

        console.log(`Fetching TubeArchivist page ${page}...`);

        const data = await tubeArchivistRequest(
            `video/?page=${page}`
        );

        let batch = [];
        let pagination = null;

        if (Array.isArray(data)) {
            batch = data;
        } else if (Array.isArray(data?.data)) {
            batch = data.data;
            pagination = data.paginate ?? null;
        } else if (Array.isArray(data?.results)) {
            batch = data.results;
            pagination = data.pagination ?? data.paginate ?? null;
        } else if (Array.isArray(data?.items)) {
            batch = data.items;
            pagination = data.pagination ?? data.paginate ?? null;
        } else {
            throw new Error(
                "Unexpected TubeArchivist video-list response format"
            );
        }

        if (pagination) {
            const total = Number(pagination.total_hits);

            if (Number.isFinite(total) && total >= 0) {
                expectedTotal = total;
            }
        }

        if (batch.length === 0) {
            break;
        }

        let newCount = 0;

        for (const video of batch) {
            const youtubeId = video.youtube_id || video.id;

            if (!youtubeId) {
                continue;
            }

            if (!videosById.has(youtubeId)) {
                newCount++;
            }

            videosById.set(youtubeId, video);
        }

        console.log(
            `Page ${page}: ${batch.length} returned, ` +
            `${newCount} new, ${videosById.size} unique`
        );

        const nextPages = Array.isArray(pagination?.next_pages)
            ? pagination.next_pages
                .map(Number)
                .filter(Number.isFinite)
            : [];

        if (nextPages.length > 0) {
            const nextPage = nextPages.find(
                candidate => !visitedPages.has(candidate)
            );

            if (nextPage === undefined) {
                break;
            }

            page = nextPage;
            continue;
        }

        const lastPage = Number(pagination?.last_page);

        if (Number.isFinite(lastPage) && lastPage >= 0) {
            if (page >= lastPage) {
                break;
            }

            page++;
            continue;
        }

        // Without pagination metadata, stop if no new IDs appear.
        if (newCount === 0) {
            console.warn(
                "No new video IDs found; stopping pagination."
            );
            break;
        }

        if (
            expectedTotal !== null &&
            videosById.size >= expectedTotal
        ) {
            break;
        }

        page++;
    }

    console.log(
        `Total unique TubeArchivist videos: ${videosById.size}`
    );

    if (
        expectedTotal !== null &&
        videosById.size < expectedTotal
    ) {
        console.warn(
            `API reports ${expectedTotal} videos, but collected ` +
            `${videosById.size}.`
        );
    }

    return [...videosById.values()];
}

// ============================================================
// GET FULL VIDEO DETAILS
// ============================================================

async function getTubeArchivistVideo(youtubeId) {
    return tubeArchivistRequest(
        `video/${encodeURIComponent(youtubeId)}/`
    );
}

// ============================================================
// NORMALIZE THE DOWNLOAD TIMESTAMP
// ============================================================

function normalizeVideo(video) {
    const youtubeId = video.youtube_id || video.id;
    const rawTimestamp = video.date_downloaded;

    if (!youtubeId || rawTimestamp == null || rawTimestamp === "") {
        return null;
    }

    const dateDownloaded = Number(rawTimestamp);

    if (
        !Number.isFinite(dateDownloaded) ||
        dateDownloaded <= 0
    ) {
        return null;
    }

    const downloadedAt = new Date(dateDownloaded * 1000);

    if (Number.isNaN(downloadedAt.getTime())) {
        return null;
    }

    // Only the fields required by the NFO generator are retained.
    return {
        youtubeId,
        dateDownloaded,
        downloadedAt,
    };
}

// ============================================================
// SAVE MINIMAL RECORD
// ============================================================

async function saveVideo(video) {
    const normalized = normalizeVideo(video);

    if (!normalized) {
        return false;
    }

    await collection.updateOne(
        { youtubeId: normalized.youtubeId },
        {
            $set: {
                dateDownloaded: normalized.dateDownloaded,
                downloadedAt: normalized.downloadedAt,
            },
            $setOnInsert: {
                youtubeId: normalized.youtubeId,
            },
        },
        { upsert: true }
    );

    return true;
}

// ============================================================
// SYNC TUBEARCHIVIST TO MONGODB
// ============================================================

async function syncTubeArchivist() {
    console.log("");
    console.log("=================================================");
    console.log("TUBEARCHIVIST -> MONGODB SYNC");
    console.log("Started:", new Date().toISOString());
    console.log("=================================================");

    let saved = 0;
    let skipped = 0;
    let failed = 0;

    try {
        const videos = await getTubeArchivistVideos();

        for (const video of videos) {
            if (stopping) {
                break;
            }

            const youtubeId = video.youtube_id || video.id;

            if (!youtubeId) {
                skipped++;
                continue;
            }

            try {
                // Get the full object because the list response may
                // not include date_downloaded.
                const fullVideo =
                    await getTubeArchivistVideo(youtubeId);

                const normalized = normalizeVideo(fullVideo);

                if (!normalized) {
                    console.warn(
                        `${youtubeId}: missing/invalid date_downloaded`
                    );
                    skipped++;
                    continue;
                }

                await saveVideo(fullVideo);
                saved++;

                console.log(
                    `Saved ${normalized.youtubeId} -> ` +
                    normalized.downloadedAt.toISOString()
                );
            } catch (error) {
                failed++;

                console.error(
                    `Failed ${youtubeId}: ${error.message}`
                );
            }
        }

        console.log("");
        console.log("Sync finished.");
        console.log("Saved:", saved);
        console.log("Skipped:", skipped);
        console.log("Failed:", failed);
        console.log("Next interval:", CHECK_INTERVAL_MS, "ms");
        console.log("=================================================");
    } catch (error) {
        console.error(
            "TubeArchivist sync failed:",
            error.message
        );
    }
}

// ============================================================
// PERIODIC LOOP
// Wait for each sync to finish before starting another.
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log("Connecting to MongoDB...");

    await mongoClient.connect();

    collection = mongoClient
        .db(MONGODB_DATABASE)
        .collection(MONGODB_COLLECTION);

    await collection.createIndex(
        { youtubeId: 1 },
        { unique: true }
    );

    console.log("MongoDB connected.");

    // Remove obsolete fields from existing documents.
    const cleanup = await collection.updateMany(
        {},
        { $unset: OBSOLETE_FIELDS }
    );

    console.log(
        `Removed obsolete fields from ${cleanup.modifiedCount} document(s).`
    );

    while (!stopping) {
        await syncTubeArchivist();

        if (!stopping) {
            console.log(
                `Waiting ${CHECK_INTERVAL_MS} ms until next sync...`
            );

            await sleep(CHECK_INTERVAL);
        }
    }
}

// ============================================================
// CLEAN SHUTDOWN
// ============================================================

async function shutdown(signal) {
    if (stopping) {
        return;
    }

    stopping = true;
    console.log(`Received ${signal}; shutting down...`);

    await mongoClient.close().catch(() => {});
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch(async error => {
    console.error("Fatal error:", error);
    await mongoClient.close().catch(() => {});
    process.exit(1);
});
