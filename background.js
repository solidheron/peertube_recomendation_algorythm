"use strict";

// --- Metadata Extraction ---
const instanceUrl = 'https://peertube.1312.media/'; // Corrected instance URL!
const count = 40;
const maxPages = 3;

// --- Tokenizer and Processing Functions ---
function stripLinks(text) {
    return text.replace(/https?:\/\/\S+|www\.\S+/g, "");
}
function initializeFromBundledData() {
    const bundledFiles = [
        { key: 'metadataList', filename: 'metadataList.json', mergeFn: mergeMetadataList },
        { key: 'processedUUIDs', filename: 'processedUUIDs.json', mergeFn: mergeProcessedUUIDs },
        { key: 'videoUUIDs', filename: 'videoUUIDs.json', mergeFn: mergeVideoUUIDs }
    ];

    bundledFiles.forEach(({ key, filename, mergeFn }) => {
        fetch(chrome.runtime.getURL(filename))
            .then(response => {
                if (!response.ok) throw new Error(`${filename} not found`);
                return response.json();
            })
            .then(data => {
                console.log(`📦 Loaded bundled ${key} from ${filename}`);
                mergeFn(data);
            })
            .catch(err => {
                console.warn(`⚠️ Could not load ${filename}:`, err.message);
            });
    });
}

function tokenize(text) {
    const tokens = text
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter(word => word.length > 1);
    console.log("Tokens generated:", tokens); // Log the tokens
    return tokens;
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
	const isSimplified = !video.name && !video.description && Array.isArray(video.Video_description_vector?.recommended_standard?.tokens);
    if (isSimplified) {
      // leave it alone
      return video;
    }
    // 1) Extract tokens exactly as before…
    let newTokens = [];
    if (video.name) { newTokens.push(...tokenize(video.name)); }
    if (Array.isArray(video.tags)) {
      video.tags.forEach(tag => tag.name && newTokens.push(tag.name.toLowerCase()));
    }
    if (video.description) {
      newTokens.push(...tokenize(stripLinks(video.description)));
    }
    newTokens = [...new Set(newTokens)];

    // 2) Grab whatever was already there  
    const oldTokens = (
      video.Video_description_vector?.recommended_standard?.tokens
      || []
    );

    // 3) If we found new tokens, use them; otherwise keep old
    const tokensToUse = newTokens.length > 0
      ? newTokens
      : oldTokens;

    // 4) Assign back (merging into any existing flags you might have)
    video.Video_description_vector = video.Video_description_vector || {};
    video.Video_description_vector.recommended_standard = video.Video_description_vector.recommended_standard || {};
    video.Video_description_vector.recommended_standard.tokens = tokensToUse;

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

    // First get the existing processed UUIDs
    chrome.storage.local.get(['processedUUIDs'], async (result) => {
        const processedUUIDs = new Set(result.processedUUIDs || []);
        console.log(`📋 Found ${processedUUIDs.size} already processed UUIDs`);

        for (const template of apiUrlTemplates) {
            console.log(`📄 Starting fetch for template: ${template}`);
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

        // Filter out UUIDs that have already been processed
        const uniqueUUIDs = Array.from(allUUIDs);
        const newUUIDs = uniqueUUIDs.filter(uuid => !processedUUIDs.has(uuid));

        if (newUUIDs.length === 0) {
            console.log("📋 No new videos found that haven't been processed already.");
            return;
        }

        console.log(`📋 Found ${newUUIDs.length} new UUIDs out of ${uniqueUUIDs.length} total`);

        chrome.storage.local.set({
            videoUUIDs: newUUIDs
        }, () => {
            console.log(`✅ Saved ${newUUIDs.length} new video UUIDs to local storage`);
            fetchAndSaveMetadata(newUUIDs);
        });
    });
}

async function fetchAndSaveMetadata(uuids) {
    chrome.storage.local.get(['processedUUIDs', 'metadataList'], (result) => {
        const processed = new Set(result.processedUUIDs || []);
        let metadataList = result.metadataList || [];
        
        // Only fetch metadata for UUIDs that haven't been processed yet
        const uuidsToProcess = uuids.filter(uuid => !processed.has(uuid));
        
        if (uuidsToProcess.length === 0) {
            console.log("✅ All UUIDs have already been processed. No new API calls needed.");
            return;
        }
        
        console.log(`🔄 Processing ${uuidsToProcess.length} new UUIDs out of ${uuids.length} total`);
        fetchMetadata(uuidsToProcess, processed, metadataList);
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
                console.log(`âœ… Fetched and saved metadata for ${uuid}`);
            });
        } catch (err) {
            console.error(`âŒ Error processing video ${uuid}:`, err.message);
            await sleep(500);
        }
    }
    const processedMetadataList = processMetadataList(metadataList);
    chrome.storage.local.set({
        metadataList: processedMetadataList
    }, () => {
        console.log(`âœ… Processed ${processedMetadataList.length} entries with recommended_standard tokens.`);
    });
}

// --- Watch Tracking ---
let watchSegments = [];
let currentSegmentStart = null;

function startTracking() {
    currentSegmentStart = Date.now();
    console.log("â–¶ï¸ Watch tracking started");
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
        console.log("â¸ï¸ Watch tracking stopped", segment);
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
        console.log("ðŸ’¾ Data exported to JSON file");
    });
}

function clearMetadataAndUUIDs() {
    chrome.storage.local.remove(['metadataList', 'processedUUIDs', 'videoUUIDs'], () => {
        console.log('ðŸ”¥ metadataList, processedUUIDs, and videoUUIDs have been cleared from storage.');
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
            // Extract tokens safely, defaulting to an empty array
            let tokens = [];
            if (newItem.Video_description_vector &&
                newItem.Video_description_vector.recommended_standard &&
                Array.isArray(newItem.Video_description_vector.recommended_standard.tokens)) {
                tokens = newItem.Video_description_vector.recommended_standard.tokens;
            }

            const extractedItem = {
                "shortUUID": newItem.shortUUID,
                "uuid": newItem.uuid,
                "url": newItem.url || `${instanceUrl.replace(/\/$/, '')}/videos/watch/${newItem.shortUUID}`,
                "Video_description_vector": {
                    "recommended_standard": {
                        "isTrue": newItem.Video_description_vector?.recommended_standard?.isTrue,
                        "tokens": tokens  // Use the extracted tokens
                    }
                }
            };

            // Check if this item already exists to avoid duplicates
            const existingIndex = mergedMetadataList.findIndex(item => item.uuid === extractedItem.uuid);

            if (existingIndex === -1) {
                // New item: simply push the extracted item
                mergedMetadataList.push(extractedItem);
            } else {
                // Existing item: merge/update tokens (ensure tokens are retained)
                const existingItem = mergedMetadataList[existingIndex];

                // Safely get existing tokens, defaulting to an empty array
                let existingTokens = [];
                if (existingItem.Video_description_vector &&
                    existingItem.Video_description_vector.recommended_standard &&
                    Array.isArray(existingItem.Video_description_vector.recommended_standard.tokens)) {
                    existingTokens = existingItem.Video_description_vector.recommended_standard.tokens;
                }

                // Merge tokens from newItem into existingItem
                const mergedTokens = [...new Set([...existingTokens, ...tokens])];

                // Update the tokens in existingItem
                existingItem.Video_description_vector = {
                    recommended_standard: {
                        isTrue: newItem.Video_description_vector?.recommended_standard?.isTrue || false,
                        tokens: mergedTokens  // Use the merged tokens
                    }
                };

                // Update the item in the merged list
                mergedMetadataList[existingIndex] = existingItem;
            }
        });

        // Set the merged metadataList in storage
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
    initializeFromBundledData(); // Load & merge bundled JSON files first
    setTimeout(() => {
        fetchVideoUUIDs(); // Give time to merge before fetching new metadata
    }, 1000); // short delay to allow merges
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