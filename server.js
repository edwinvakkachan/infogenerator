
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
    MEDIA_ROOT = "/youtube",
    OVERWRITE_NFO = "false",
    DRY_RUN = "true",
    VIDEO_EXTENSIONS = ".mp4,.mkv,.webm,.m4v,.mov"
} = process.env;

if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is missing from .env");
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
// EXTRACT YOUTUBE ID FROM VIDEO FILENAME
// Examples:
// 6Kia7r71Tmg.mp4
// Video title [6Kia7r71Tmg].mp4
// ============================================================

function extractYoutubeIdFromName(filename) {
    const stem = path.parse(filename).name;

    if (/^[A-Za-z0-9_-]{11}$/.test(stem)) {
        return stem;
    }

    const matches = [
        ...stem.matchAll(/\[([A-Za-z0-9_-]{11})\]/g)
    ];

    return matches.length === 1 ? matches[0][1] : null;
}

// ============================================================
// DATE HELPERS
// ============================================================

function toValidDate(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    let date;

    if (value instanceof Date) {
        date = value;
    } else if (typeof value === "number") {
        // Accept Unix seconds or milliseconds.
        date = new Date(
            Math.abs(value) < 1e12
                ? value * 1000
                : value
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

// Jellyfin NFO dateadded format in UTC.
function formatNfoDate(date) {
    return date
        .toISOString()
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
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>${escapeXml(record.title || youtubeId)}</title>
  <dateadded>${formatNfoDate(date)}</dateadded>
  <uniqueid type="youtube" default="true">${youtubeId}</uniqueid>
</episodedetails>
`;
}

// Update only dateadded, preserving the other existing XML content.
function updateExistingNfo(xml, date) {
    const dateTag =
        `<dateadded>${formatNfoDate(date)}</dateadded>`;

    const existingDateTag =
        /<dateadded\b[^>]*>[\s\S]*?<\/dateadded>/i;

    if (existingDateTag.test(xml)) {
        return {
            ok: true,
            content: xml.replace(existingDateTag, dateTag)
        };
    }

    // Insert dateadded inside the existing root element.
    const rootTag =
        /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>/;

    const match = rootTag.exec(xml);

    if (!match) {
        return {
            ok: false,
            reason: "No recognizable XML root element"
        };
    }

    const insertAt = match.index + match[0].length;

    return {
        ok: true,
        content:
            xml.slice(0, insertAt) +
            "\n  " +
            dateTag +
            xml.slice(insertAt)
    };
}

// ============================================================
// READ YOUTUBE ID FROM .info.json IF NEEDED
// ============================================================

async function readYoutubeIdFromInfoJson(infoPath) {
    try {
        const info = JSON.parse(
            await fs.readFile(infoPath, "utf8")
        );

        const id =
            info.id ||
            info.youtube_id ||
            info.youtubeId;

        return (
            typeof id === "string" &&
            /^[A-Za-z0-9_-]{11}$/.test(id)
        )
            ? id
            : null;
    } catch {
        return null;
    }
}

// ============================================================
// SCAN TUBEARCHIVIST MEDIA FOLDER
//
// /youtube/
//   CHANNEL_ID/
//     6Kia7r71Tmg.mp4
//     6Kia7r71Tmg.info.json
//     6Kia7r71Tmg.nfo
// ============================================================

async function scanVideoFiles(root) {
    const videosById = new Map();

    let scannedFiles = 0;
    let infoJsonFiles = 0;

    async function walk(directory) {
        const entries = await fs.readdir(
            directory,
            { withFileTypes: true }
        );

        for (const entry of entries) {
            const fullPath = path.join(
                directory,
                entry.name
            );

            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const extension =
                path.extname(entry.name).toLowerCase();

            if (!allowedExtensions.has(extension)) {
                continue;
            }

            scannedFiles++;

            let youtubeId =
                extractYoutubeIdFromName(entry.name);

            // Fallback to the corresponding info.json file.
            if (!youtubeId) {
                const infoPath = path.join(
                    directory,
                    `${path.parse(entry.name).name}.info.json`
                );

                youtubeId =
                    await readYoutubeIdFromInfoJson(infoPath);
            }

            if (!youtubeId) {
                continue;
            }

            if (!videosById.has(youtubeId)) {
                videosById.set(youtubeId, []);
            }

            videosById.get(youtubeId).push(fullPath);
        }
    }

    async function countInfoFiles(directory) {
        const entries = await fs.readdir(
            directory,
            { withFileTypes: true }
        );

        for (const entry of entries) {
            const fullPath = path.join(
                directory,
                entry.name
            );

            if (entry.isDirectory()) {
                await countInfoFiles(fullPath);
            } else if (
                entry.isFile() &&
                entry.name.endsWith(".info.json")
            ) {
                infoJsonFiles++;
            }
        }
    }

    await walk(root);
    await countInfoFiles(root);

    console.log(`📁 Video files scanned: ${scannedFiles}`);
    console.log(`🧾 .info.json files found: ${infoJsonFiles}`);
    console.log(
        `🔗 Video files matched to YouTube IDs: ${videosById.size}`
    );

    return videosById;
}

// ============================================================
// CREATE OR UPDATE NFO
// ============================================================

async function writeNfo(
    videoPath,
    record,
    youtubeId,
    date
) {
    const nfoPath = path.join(
        path.dirname(videoPath),
        `${path.basename(
            videoPath,
            path.extname(videoPath)
        )}.nfo`
    );

    let existingContent = null;

    try {
        existingContent = await fs.readFile(
            nfoPath,
            "utf8"
        );
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    // Preserve existing NFO unless overwrite is explicitly enabled.
    if (existingContent !== null) {
        if (!overwriteNfo) {
            return "skipped-existing";
        }

        const result = updateExistingNfo(
            existingContent,
            date
        );

        if (!result.ok) {
            console.warn(
                `⚠️ Could not safely edit NFO: ${nfoPath}`
            );
            console.warn(`   ${result.reason}`);

            return "invalid-existing";
        }

        if (result.content === existingContent) {
            return "already-correct";
        }

        if (dryRun) {
            console.log(
                `🧪 Would update dateadded: ${nfoPath}`
            );

            return "would-update";
        }

        await fs.writeFile(
            nfoPath,
            result.content,
            "utf8"
        );

        console.log(`📝 Updated dateadded: ${nfoPath}`);

        return "updated";
    }

    const content = createNfo(
        record,
        youtubeId,
        date
    );

    if (dryRun) {
        console.log(`🧪 Would create: ${nfoPath}`);
        return "would-create";
    }

    // "wx" prevents accidentally overwriting an existing file.
    try {
        await fs.writeFile(
            nfoPath,
            content,
            {
                encoding: "utf8",
                flag: "wx"
            }
        );
    } catch (error) {
        if (error.code === "EEXIST") {
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

    const rootStats = await fs
        .stat(mediaRoot)
        .catch(() => null);

    if (!rootStats?.isDirectory()) {
        throw new Error(
            `MEDIA_ROOT is not an accessible directory: ${mediaRoot}`
        );
    }

    console.log("");
    console.log("=================================================");
    console.log("🎬 TUBEARCHIVIST NFO DATE ADDED GENERATOR");
    console.log("=================================================");
    console.log(`📂 Media root: ${mediaRoot}`);
    console.log(
        `🗄️ MongoDB: ${MONGODB_DATABASE}.${MONGODB_COLLECTION}`
    );
    console.log(
        `✏️ Overwrite existing NFO: ${overwriteNfo}`
    );
    console.log(`🧪 Dry run: ${dryRun}`);

    await mongoClient.connect();

    const collection = mongoClient
        .db(MONGODB_DATABASE)
        .collection(MONGODB_COLLECTION);

    const records = await collection.find({
        youtubeId: {
            $exists: true,
            $ne: null
        },
        $or: [
            {
                downloadedAt: {
                    $exists: true,
                    $ne: null
                }
            },
            {
                dateDownloaded: {
                    $exists: true,
                    $ne: null
                }
            }
        ]
    }).toArray();

    console.log(
        `📊 MongoDB records with date fields: ${records.length}`
    );

    const recordsById = new Map();
    let invalidRecords = 0;

    for (const record of records) {
        const youtubeId =
            String(record.youtubeId).trim();

        const date = getDownloadedAt(record);

        if (
            !/^[A-Za-z0-9_-]{11}$/.test(youtubeId) ||
            !date
        ) {
            invalidRecords++;
            continue;
        }

        recordsById.set(youtubeId, {
            ...record,
            _nfoDate: date
        });
    }

    const videosById =
        await scanVideoFiles(mediaRoot);

    const stats = {
        created: 0,
        updated: 0,
        skippedExisting: 0,
        alreadyCorrect: 0,
        missingFiles: 0,
        missingRecords: 0,
        invalidExisting: 0,
        wouldCreate: 0,
        wouldUpdate: 0,
        failed: 0
    };

    const resultKeys = {
        "created": "created",
        "updated": "updated",
        "skipped-existing": "skippedExisting",
        "already-correct": "alreadyCorrect",
        "invalid-existing": "invalidExisting",
        "would-create": "wouldCreate",
        "would-update": "wouldUpdate"
    };

    // Process existing and newly downloaded videos.
    for (const [youtubeId, record] of recordsById) {
        const videoPaths =
            videosById.get(youtubeId);

        if (!videoPaths?.length) {
            console.log(
                `⏳ No local video file found: ${youtubeId}`
            );

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

                const key = resultKeys[result];

                if (key) {
                    stats[key]++;
                }
            } catch (error) {
                stats.failed++;

                console.error(`❌ Failed: ${videoPath}`);
                console.error(`   ${error.message}`);
            }
        }
    }

    // Count local video IDs that have no valid MongoDB record.
    for (const youtubeId of videosById.keys()) {
        if (!recordsById.has(youtubeId)) {
            stats.missingRecords++;
        }
    }

    console.log("");
    console.log("=================================================");
    console.log("📋 SUMMARY");
    console.log("=================================================");
    console.log(
        `📊 Valid MongoDB records: ${recordsById.size}`
    );
    console.log(
        `⚠️ Invalid MongoDB records: ${invalidRecords}`
    );
    console.log(`✅ NFO files created: ${stats.created}`);
    console.log(
        `📝 Existing NFO dates updated: ${stats.updated}`
    );
    console.log(
        `⏭️ Existing NFO files preserved: ${stats.skippedExisting}`
    );
    console.log(
        `✔️ Dates already correct: ${stats.alreadyCorrect}`
    );
    console.log(`🧪 Would create: ${stats.wouldCreate}`);
    console.log(`🧪 Would update: ${stats.wouldUpdate}`);
    console.log(
        `⏳ Records with no local video: ${stats.missingFiles}`
    );
    console.log(
        `❓ Local video IDs missing from MongoDB: ${stats.missingRecords}`
    );
    console.log(
        `⚠️ Existing NFO files not safely editable: ${stats.invalidExisting}`
    );
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
