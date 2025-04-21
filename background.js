"use strict";

// --- Metadata Extraction ---
const instanceUrl = 'https://dalek.zone/'; // Corrected instance URL!
const count = 10;
const maxPages = 1;

// --- Tokenizer and Processing Functions ---
function stripLinks(text) {
    return text.replace(/https?:\/\/\S+|www\.\S+/g, "");
}

function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter(word => word.length > 1);
}

// Function to download metadataList
function downloadMetadataList() {
    chrome.storage.local.get(['metadataList'], (result) => {
        const metadataList = result.metadataList || [];
        const jsonString = JSON.stringify(metadataList, null, 2); // Convert to JSON with indentation
        const blob = new Blob([jsonString], {
            type: 'application/json'
        });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({
            url: url,
            filename: 'metadataList.json', // Suggested filename
            conflictAction: 'uniquify' // Automatically rename if the file already exists
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("Download failed:", chrome.runtime.lastError.message);
            } else {
                console.log("Download started with ID:", downloadId);
                URL.revokeObjectURL(url); // Release the Blob URL after starting the download
            }
        });
    });
}

// Listen for a message to trigger the download
chrome.runtime.onMessage.addListener(
    function (request, sender, sendResponse) {
        if (request.action === "downloadMetadata") {
            downloadMetadataList();
        }
    }
);

function processMetadataList(metadataList) {
    return metadataList.map(video => {
        let tokens = [];
        if (video.name) {
            tokens.push(...tokenize(video.name));
        }

        if (Array.isArray(video.tags)) {
            video.tags.forEach(tag => {
                if (tag && tag.name) {
                    tokens.push(tag.name.toLowerCase());
                }
            });
        }

        if (video.description) {
            const cleanDesc = stripLinks(video.description);
            tokens.push(...tokenize(cleanDesc));
        }

        tokens = [...new Set(tokens)];
        // Assign tokens to Video_description_vector as a sub-element
        video.Video_description_vector = {
            recommended_standard: {
                "tokens": tokens
            }
        };
        return video;
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchVideoUUIDs() {
    const baseUrl = instanceUrl.replace(/\/$/, '');
    const allUUIDs = new Set();
    const newestTemplate = `${baseUrl}/api/v1/videos?sort=-publishedAt&nsfw=both&count=${count}`;
    const apiUrlTemplates = [
        newestTemplate,
        `${baseUrl}/api/v1/videos?sort=-createdAt&count=${count}`,
        `${baseUrl}/api/v1/videos?sort=-views&count=${count}`,
        `${baseUrl}/api/v1/videos?sort=-likes&count=${count}`,
        `${baseUrl}/api/v1/videos?sort=-trending&count=${count}`,
        `${baseUrl}/api/v1/videos?count=${count}`
    ];

    for (const template of apiUrlTemplates) {
        console.log(`🔄 Starting fetch for template: ${template}`);
        if (template === newestTemplate) {
            for (let startVal = 0; startVal < maxPages * count; startVal += count) {
                const pagedUrl = template + `&start=${startVal}`;
                try {
                    const response = await fetch(pagedUrl);
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`Failed to fetch videos: ${response.statusText}\n${errorText}`);
                    }

                    const data = await response.json();
                    const uuids = Array.isArray(data.data) ? data.data.map(v => v.uuid) : [];
                    if (uuids.length === 0) {
                        console.log(`ℹ️ No more videos at start=${startVal} for this template.`);
                        break;
                    }

                    uuids.forEach(uuid => allUUIDs.add(uuid));
                    console.log(`✅ Retrieved ${uuids.length} UUIDs from: ${pagedUrl}`);
                } catch (err) {
                    console.error(`❌ Error fetching from ${pagedUrl}:`, err.message);
                    await sleep(500);
                }
            }
        } else {
            const pagedUrl = template + `&start=0`;
            try {
                const response = await fetch(pagedUrl);
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Failed to fetch videos: ${response.statusText}\n${errorText}`);
                }

                const data = await response.json();
                const uuids = Array.isArray(data.data) ? data.data.map(v => v.uuid) : [];
                uuids.forEach(uuid => allUUIDs.add(uuid));
                console.log(`✅ Retrieved ${uuids.length} UUIDs from: ${pagedUrl}`);
            } catch (err) {
                console.error(`❌ Error fetching from ${pagedUrl}:`, err.message);
                await sleep(500);
            }
        }
    }

    const uniqueUUIDs = Array.from(allUUIDs);
    if (uniqueUUIDs.length === 0) {
        console.log("⚠️ No videos found from any API endpoint.");
        return;
    }

    chrome.storage.local.set({
        videoUUIDs: uniqueUUIDs
    }, () => {
        console.log(`✅ Saved ${uniqueUUIDs.length} unique video UUIDs to local storage`);
        fetchAndSaveMetadata(uniqueUUIDs);
    });
}

async function fetchAndSaveMetadata(uuids) {
    chrome.storage.local.get(['processedUUIDs', 'metadataList'], (result) => {
        const processed = new Set(result.processedUUIDs || []);
        let metadataList = result.metadataList || [];
        fetchMetadata(uuids, processed, metadataList);
    });
}

async function fetchMetadata(uuids, processed, metadataList) {
    for (const uuid of uuids) {
        if (processed.has(uuid)) {
            continue;
        }

        const videoApiUrl = `${instanceUrl.replace(/\/$/, '')}/api/v1/videos/${uuid}`;
        try {
            const response = await fetch(videoApiUrl);
            if (!response.ok) {
                if (response.status === 404) {
                    console.warn(`Video ${uuid} not found on instance. Skipping.`);
                    processed.add(uuid); // Mark as processed to avoid retrying
                    continue; // Skip to the next UUID
                } else {
                    throw new Error(`Failed to fetch metadata for ${uuid}: ${response.statusText}`);
                }
            }
            const metadata = await response.json();
            const shortUUID = metadata.shortUUID; // Extract shortUUID

            // Add the shortUUID to the metadata object
            metadata.shortUUID = shortUUID;

            metadataList.push(metadata);
            processed.add(uuid);
            chrome.storage.local.set({
                metadataList: metadataList,
                processedUUIDs: Array.from(processed)
            }, () => {
                console.log(`✅ Fetched and saved metadata for ${uuid}`);
            });
        } catch (err) {
            console.error(`❌ Error processing video ${uuid}:`, err.message);
            await sleep(500);
        }
    }
    const processedMetadataList = processMetadataList(metadataList);
    chrome.storage.local.set({
        metadataList: processedMetadataList
    }, () => {
        console.log(`✅ Processed ${processedMetadataList.length} entries with recommended_standard tokens.`);
    });
}

// --- Watch Tracking ---
let watchSegments = [];
let currentSegmentStart = null;

function startTracking() {
    currentSegmentStart = Date.now();
    console.log("▶️ Watch tracking started");
}

function stopTracking() {
    if (currentSegmentStart !== null) {
        const segment = {
            start: currentSegmentStart,
            end: Date.now(),
            duration: Date.now() - currentSegmentStart
        };
        watchSegments.push(segment);
        currentSegmentStart = null;
        console.log("⏸️ Watch tracking stopped", segment);
    }
}

// --- Data Export ---
function saveDataToJsonFile(data, filename = 'data.json') {
    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], {
        type: 'application/json'
    });
    const reader = new FileReader();
    reader.onload = function (event) {
        chrome.downloads.download({
            url: event.target.result,
            filename: filename,
            saveAs: true
        }, function (downloadId) {
            if (downloadId === undefined) {
                console.error("Download failed:", chrome.runtime.lastError);
            } else {
                console.log("Download started with ID:", downloadId);
            }
        });
    };
    reader.readAsDataURL(blob);
}

function exportData() {
    // Retrieve watchSegments and metadataList from storage, then proceed with export
    chrome.storage.local.get(['watchSegments', 'metadataList'], (result) => {
        const data = {
            segments: result.watchSegments || [],
            metadata: result.metadataList || [],
            exportedAt: Date.now()
        };
        saveDataToJsonFile(data, 'peertube_watch_history.json');
        console.log("💾 Data exported to JSON file");
    });
}

function clearMetadataAndUUIDs() {
    chrome.storage.local.remove(['metadataList', 'processedUUIDs', 'videoUUIDs'], () => {
        console.log('🔥 metadataList, processedUUIDs, and videoUUIDs have been cleared from storage.');
    });
}

function loadProcessedUUIDsToStorage(data) {
    chrome.storage.local.set({
        processedUUIDs: data
    }, () => {
        console.log('processedUUIDs loaded successfully into storage.');
    });
}

// --- Message Listener (from content script and popup) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "startTracking") {
        startTracking();
    } else if (message.action === "stopTracking") {
        stopTracking();
    } else if (message.action === "exportData") {
        exportData();
    } else if (message.action === 'manualExport' || message.action === 'autoExport') {
        const historyData = message.data;
        saveDataToJsonFile(JSON.parse(historyData), 'peertube_watch_history.json');
    } else if (message.action === "clearData") {
        clearMetadataAndUUIDs();
    } else if (message.action === "mergeProcessedUUIDs") {
        mergeProcessedUUIDs(message.data);
    } else if (message.action === "mergeVideoUUIDs") {
        mergeVideoUUIDs(message.data);
    } else if (message.action === "mergeMetadataList") {
        mergeMetadataList(message.data);
    }
});

function mergeProcessedUUIDs(newData) {
    chrome.storage.local.get(['processedUUIDs'], (result) => {
        let existingUUIDs = result.processedUUIDs || [];
        if (!Array.isArray(existingUUIDs)) {
            existingUUIDs = [];
        }

        const newUUIDs = Array.isArray(newData) ? newData : [];
        const mergedUUIDs = [...new Set([...existingUUIDs, ...newUUIDs])];
        chrome.storage.local.set({
            processedUUIDs: mergedUUIDs
        }, () => {
            console.log('processedUUIDs merged successfully.');
        });
    });
}

function mergeVideoUUIDs(newData) {
    chrome.storage.local.get(['videoUUIDs'], (result) => {
        let existingUUIDs = result.videoUUIDs || [];
        if (!Array.isArray(existingUUIDs)) {
            existingUUIDs = [];
        }

        const newUUIDs = Array.isArray(newData) ? newData : [];
        const mergedUUIDs = [...new Set([...existingUUIDs, ...newUUIDs])];
        chrome.storage.local.set({
            videoUUIDs: mergedUUIDs
        }, () => {
            console.log('videoUUIDs merged successfully.');
        });
    });
}

function mergeMetadataList(newData) {
    chrome.storage.local.get(['metadataList'], (result) => {
        let existingMetadataList = result.metadataList || [];
        if (!Array.isArray(existingMetadataList)) {
            existingMetadataList = [];
        }

        const newMetadataList = Array.isArray(newData) ? newData : [];
        let mergedMetadataList = [...existingMetadataList];

        // Process each new item
        newMetadataList.forEach(newItem => {
            const extractedItem = {
                "shortUUID": newItem.shortUUID,
                "uuid": newItem.uuid,
                "Video_description_vector": {
                    "recommended_standard": {
                        "isTrue": newItem.Video_description_vector?.recommended_standard?.isTrue,
                        "tokens": newItem.Video_description_vector?.recommended_standard?.tokens
                    }
                }
            };

            // Check if this item already exists to avoid duplicates
            const existingIndex = mergedMetadataList.findIndex(item => item.uuid === extractedItem.uuid);
            if (existingIndex === -1) {
                mergedMetadataList.push(extractedItem);
            } else {
                // If it exists, replace the existing item with the new one
                mergedMetadataList[existingIndex] = extractedItem;
            }
        });

        // No size limit. Get all entries.
        chrome.storage.local.set({
            metadataList: mergedMetadataList
        }, () => {
            console.log('metadataList merged successfully. Size:', mergedMetadataList.length);
        });
    });
}

// --- Event Listeners ---
chrome.runtime.onInstalled.addListener(() => {
    console.log("Extension installed/updated");
    fetchVideoUUIDs();
});

// Periodic metadata fetch
chrome.alarms.create('metadataFetcher', {
    periodInMinutes: 60
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'metadataFetcher') {
        console.log("Running periodic metadata fetch");
        fetchVideoUUIDs();
    }
});

function checkStorageUsage() {
    chrome.storage.local.getBytesInUse(null, (bytes) => {
        const megabytes = bytes / (1024 * 1024);
        console.log(`Storage usage: ${megabytes.toFixed(2)} MB`);
    });
}

// Call this function periodically (e.g., every hour)
setInterval(checkStorageUsage, 3600000);
