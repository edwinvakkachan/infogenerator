
import "dotenv/config";
import { MongoClient } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";

// ============================================================
// CONFIGURATION
// ============================================================

const {
    MONGODB_URI,
    MONGODB_DATABASE = "tubearchivist",
    MONGODB_COLLECTION = "jellyfin_sync",

    // Set this to the actual TubeArchivist media folder.
    MEDIA_ROOT,

    // Existing NFO files are never replaced by default.
    OVERWRITE_NFO = "false",

    // Set true to preview actions without writing files.
    DRY_RUN = "false",

    // TubeArchivist normally uses MP4.
    VIDEO_EXTENSIONS = ".mp4,.mkv,.webm,.m4v,.mov"
} = process.env;

if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is missing from .env");
}

if (!MEDIA_ROOT) {
    throw new Error("MEDIA_ROOT is missing from .env");
}

const overwriteNfo = OVERWRITE_NFO.toLowerCase() === "true";
const dryRun = DRY_RUN.toLowerCase() === "true";

const allowedExtensions = new Set(
    VIDEO_EXTENSIONS.split(",")
        .map(ext => ext.trim().toLowerCase())
        .filter(Boolean)
);

const mongoClient = new MongoClient(MONGODB_URI);

// ============================================================
// YOUTUBE ID EXTRACTION
// TubeArchivist typically stores files as:
// <MEDIA_ROOT>/<channel-id>/<youtube-id>.mp4
// ============================================================

function extractYoutubeId(filename) {
    const stem = path.parse(filename).name;

    // Standard TubeArchivist filename: youtubeId.mp4
    if (/^[A-Za-z0-9_-]{11}$/.test(stem)) {
        return stem;
    }

    // Also support yt-dlp-style names: Title [youtubeId].mp4
    const matches = [...stem.matchAll(
        /\[([A-Za-z0-9_-]{11})\]/g
    )];

    if (matches.length === 1) {
        return matches[0][1];
    }

    return null;
}

// ============================================================
// DATE CONVERSION
// downloadedAt is normally a MongoDB Date.
// dateDownloaded is a fallback Unix timestamp in seconds.
// ============================================================

function toValidDate(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    let date;

    if (value instanceof Date) {
        date = value;
    } else if (typeof value === "number") {
        // Accept seconds or milliseconds.
        date = new Date(
            Math.abs(value) < 1e12 ? value * 1000 : value
        );
    } else {
        date = new Date(value);
    }

    return Number.isNaN(date.getTime()) ? null : date;
}

function getDownloadedAt(record) {
    return (
        toValidDate(record.downloadedAt) ||
        toValidDate(record.dateDownloaded)
    );
}

// Jellyfin NFO dateadded uses UTC: YYYY-MM-DD HH:mm:ss
function formatNfoDate(date) {
    return date.toISOString()
        .replace("T", " ")
        .slice(0, 19);
}

// ============================================================
// XML HELPERS
// ============================================================

function escapeXml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function createNfo(record, youtubeId, date) {
    const title = escapeXml(record.title || youtubeId);
    const dateAdded = formatNfoDate(date);

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>${title}</title>
  <dateadded>${dateAdded}</dateadded>
  <uniqueid type="youtube" default="true">${youtubeId}</uniqueid>
</episodedetails>
`;
}

// Update just the dateadded field, preserving other XML metadata.
function updateExistingNfo(xml, date) {
    const dateAdded = formatNfoDate(date);
    const dateTag = `<dateadded>${dateAdded}</dateadded>`;

    const existingDateTag =
        /<dateadded\b[^>]*>[\s\S]*?<\/dateadded>/i;

    if (existingDateTag.test(xml)) {
        return {
            ok: true,
            content: xml.replace(existingDateTag, dateTag)
        };
    }

    // Find the root element, not the XML declaration.
    const rootTag = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>/;
    const match = rootTag.exec(xml);

    if (!match) {
        return {
            ok: false,
            reason: "Existing NFO has no recognizable XML root element"
        };
    }

    const insertAt = match.index + match[0].length;

    return {
        ok: true,
        content:
            xml.slice(0, insertAt) +
            "\n  " + dateTag +
            xml.slice(insertAt)
    };
}

// ============================================================
// RECURSIVE VIDEO SCAN
// Maps YouTube ID -> actual video file paths.
// ============================================================

async function scanVideoFiles(root) {
    const videosById = new Map();
    let scannedFiles = 0;

    async function walk(directory) {
        const entries = await fs.readdir(directory, {
            withFileTypes: true
        });

        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const extension = path.extname(entry.name).toLowerCase();

            if (!allowedExtensions.has(extension)) {
                continue;
            }

            scannedFiles++;

            const youtubeId = extractYoutubeId(entry.name);

            if (!youtubeId) {
                continue;
            }

            if (!videosById.has(youtubeId)) {
                videosById.set(youtubeId, []);
            }

            videosById.get(youtubeId).push(fullPath);
        }
    }

    await walk(root);

    console.log(`📁 Video files scanned: ${scannedFiles}`);
    console.log(`🔗 Files matched to YouTube IDs: ${videosById.size}`);

    return videosById;
}

// ============================================================
// WRITE OR PRESERVE NFO
// ============================================================

async function writeNfo(videoPath, record, youtubeId, date) {
    const directory = path.dirname(videoPath);
    const basename = path.basename(
        videoPath,
        path.extname(videoPath)
    );

    // Example: abc12345678.mp4 -> abc12345678.nfo
    const nfoPath = path.join(directory, `${basename}.nfo`);

    let existingContent = null;

    try {
        existingContent = await fs.readFile(nfoPath, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    if (existingContent !== null) {
        if (!overwriteNfo) {
            return "skipped-existing";
        }

        const result = updateExistingNfo(existingContent, date);

        if (!result.ok) {
            console.warn(
                `⚠️ Cannot safely update existing NFO: ${nfoPath}`
            );
            console.warn(`   ${result.reason}`);
            return "invalid-existing";
        }

        // Do not rewrite the file if dateadded is already correct.
        if (result.content === existingContent) {
            return "already-correct";
        }

        if (dryRun) {
            console.log(`🧪 Would update dateadded: ${nfoPath}`);
            return "would-update";
        }

        await fs.writeFile(nfoPath, result.content, "utf8");
        console.log(`📝 Updated dateadded: ${nfoPath}`);
        return "updated";
    }

    const content = createNfo(record, youtubeId, date);

    if (dryRun) {
        console.log(`🧪 Would create: ${nfoPath}`);
        return "would-create";
    }

    // "wx" prevents overwriting a file created by another process.
    try {
        await fs.writeFile(nfoPath, content, {
            encoding: "utf8",
            flag: "wx"
        });
    } catch (error) {
        if (error.code === "EEXIST") {
            console.warn(`⚠️ NFO appeared during scan; preserved: ${nfoPath}`);
            return "skipped-existing";
        }
        throw error;
    }

    console.log(`✅ Created: ${nfoPath}`);
    return "created";
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    const mediaRoot = path.resolve(MEDIA_ROOT);

    const rootStats = await fs.stat(mediaRoot).catch(() => null);

    if (!rootStats?.isDirectory()) {
        throw new Error(`MEDIA_ROOT is not an accessible directory: ${mediaRoot}`);
    }

    console.log("=================================================");
    console.log("🎬 TUBEARCHIVIST NFO DATE ADDED GENERATOR");
    console.log("=================================================");
    console.log(`📂 Media root: ${mediaRoot}`);
    console.log(`🗄️ MongoDB database: ${MONGODB_DATABASE}`);
    console.log(`📚 MongoDB collection: ${MONGODB_COLLECTION}`);
    console.log(`✏️ Overwrite existing NFO date: ${overwriteNfo}`);
    console.log(`🧪 Dry run: ${dryRun}`);

    await mongoClient.connect();

    const collection = mongoClient
        .db(MONGODB_DATABASE)
        .collection(MONGODB_COLLECTION);

    const records = await collection.find({
        youtubeId: { $exists: true, $ne: null },
        $or: [
            { downloadedAt: { $exists: true, $ne: null } },
            { dateDownloaded: { $exists: true, $ne: null } }
        ]
    }).toArray();

    console.log(`📊 MongoDB records with download dates: ${records.length}`);

    const recordsById = new Map();

    for (const record of records) {
        const youtubeId = String(record.youtubeId).trim();
        const date = getDownloadedAt(record);

        if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId) || !date) {
            continue;
        }

        recordsById.set(youtubeId, { ...record, _nfoDate: date });
    }

    const videosById = await scanVideoFiles(mediaRoot);

    const stats = {
        created: 0,
        updated: 0,
        skippedExisting: 0,
        alreadyCorrect: 0,
        missingFiles: 0,
        missingRecords: 0,
        invalidDatesOrIds: records.length - recordsById.size,
        invalidExisting: 0,
        wouldCreate: 0,
        wouldUpdate: 0,
        failed: 0
    };

    // Process every database record, including previously downloaded videos.
    for (const [youtubeId, record] of recordsById) {
        const videoPaths = videosById.get(youtubeId);

        if (!videoPaths?.length) {
            console.log(`⏳ No matching local video file: ${youtubeId}`);
            stats.missingFiles++;
            continue;
        }

        for (const videoPath of videoPaths) {
            try {
                const result = await writeNfo(
                    videoPath,
                    record,
                    youtubeId,
                    record._nfoDate
                );

                switch (result) {
                    case "created":
                        stats.created++;
                        break;
                    case "updated":
                        stats.updated++;
                        break;
                    case "skipped-existing":
                        stats.skippedExisting++;
                        break;
                    case "already-correct":
                        stats.alreadyCorrect++;
                        break;
                    case "invalid-existing":
                        stats.invalidExisting++;
                        break;
                    case "would-create":
                        stats.wouldCreate++;
                        break;
                    case "would-update":
                        stats.wouldUpdate++;
                        break;
                }
            } catch (error) {
                stats.failed++;
                console.error(`❌ Failed: ${videoPath}`);
                console.error(`   ${error.message}`);
            }
        }
    }

    // Count matched local files without corresponding MongoDB records.
    for (const youtubeId of videosById.keys()) {
        if (!recordsById.has(youtubeId)) {
            stats.missingRecords++;
        }
    }

    console.log("");
    console.log("=================================================");
    console.log("📋 NFO GENERATION SUMMARY");
    console.log("=================================================");
    console.log(`✅ NFO files created: ${stats.created}`);
    console.log(`📝 Existing NFO dates updated: ${stats.updated}`);
    console.log(`⏭️ Existing NFO files preserved: ${stats.skippedExisting}`);
    console.log(`✔️ Dates already correct: ${stats.alreadyCorrect}`);
    console.log(`🧪 Would create: ${stats.wouldCreate}`);
    console.log(`🧪 Would update: ${stats.wouldUpdate}`);
    console.log(`⏳ MongoDB records with no local video: ${stats.missingFiles}`);
    console.log(`❓ Local video IDs missing from MongoDB: ${stats.missingRecords}`);
    console.log(`⚠️ Existing NFO files not safely editable: ${stats.invalidExisting}`);
    console.log(`⚠️ Invalid IDs/dates: ${stats.invalidDatesOrIds}`);
    console.log(`❌ Failures: ${stats.failed}`);
}

main()
    .catch(error => {
        console.error("❌ NFO generator failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoClient.close().catch(() => {});
    });
