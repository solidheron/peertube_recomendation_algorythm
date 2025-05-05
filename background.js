"use strict";

const instances = [
  'https://peertube.1312.media',
  'https://video.blender.org',
  'https://peertube.wtf',
  'https://tilvids.com',
  'https://peertube.tangentfox.com',
  'https://video.hardlimit.com'
];

const instanceUrl = 'https://dalek.zone';
//const count = 15;
//const maxPages = 2;
async function processAllInstances() {
  for (const instance of instances) {
    await fetchVideoUUIDs(instance);
    await sleep(5000); // 5s between instances
  }
}

// Function to clean existing metadata in storage
function cleanExistingMetadata() {
  chrome.storage.local.get(['metadataList'], (result) => {
    if (result.metadataList) {
      const cleanedList = result.metadataList.map(cleanMetadata);
      chrome.storage.local.set({ metadataList: cleanedList }, () => {
        console.log('✅ Cleaned existing metadata list');
        
        // Log storage usage
        chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
          console.log(`📊 Storage usage: ${(bytesInUse / 1024 / 1024).toFixed(2)} MB`);
        });
      });
    }
  });
}

// Add to runtime.onInstalled listener
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('metadataFetcher', { periodInMinutes: 60 });
  cleanExistingMetadata(); // Clean existing metadata on installation/update
  processAllInstances();
});
// Helper functions
function stripLinks(text) {
  return text.replace(/https?:\/\/\S+|www\.\S+/g, "");
}

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(word => word.length > 1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processMetadataList(metadataList) {
  return metadataList.map(video => {
    if (video.isLive || !video.name && !video.description) return cleanMetadata(video);

    let tokens = [];
    if (video.name) tokens.push(...tokenize(video.name));
    if (Array.isArray(video.tags)) {
      video.tags.forEach(tag => {
        if (tag?.name) tokens.push(tag.name.toLowerCase());
      });
    }
    if (video.description) tokens.push(...tokenize(stripLinks(video.description)));
    tokens = [...new Set(tokens)];

    const cleanedVideo = cleanMetadata(video);
    cleanedVideo.Video_description_vector = cleanedVideo.Video_description_vector || {};
    cleanedVideo.Video_description_vector.recommended_standard = cleanedVideo.Video_description_vector.recommended_standard || {};
    cleanedVideo.Video_description_vector.recommended_standard.tokens = tokens;

    return cleanedVideo;
  });
}
// Fetch and save video metadata
async function fetchVideoUUIDs(currentInstance) {
chrome.storage.local.get('hasRunBefore', (result) => {
let count, maxPages;

if (result.hasRunBefore) {
  count = 100;
  maxPages = 2;
} else {
  count = 10;
  maxPages = 1;
  chrome.storage.local.set({ hasRunBefore: true });
}
  currentInstance = currentInstance || instanceUrl;
  const baseUrl = currentInstance.replace(/\/$/, '');
  const allUUIDs = new Set();
  
  // Use the most efficient endpoints that return multiple videos
  const apiUrlTemplates = [
    `${baseUrl}/api/v1/videos?sort=-publishedAt&nsfw=both&count=${count}`,
    `${baseUrl}/api/v1/videos?sort=-trending&count=${count}`,
    `${baseUrl}/api/v1/videos?sort=-views&count=${count}`
  ];
  
  const storageKey = `processedUUIDs`;

  chrome.storage.local.get([storageKey], async (result) => {
    const processedUUIDs = new Set(result[storageKey] || []);
    
    // Collect all promises for parallel execution
    const fetchPromises = apiUrlTemplates.map(async (template) => {
      // For each template, fetch multiple pages
      for (let start = 0; start < maxPages * count; start += count) {
        const url = template + `&start=${start}`;
        try {
          const response = await fetch(url);
          if (!response.ok) break;
          const data = await response.json();
          
          // Extract both UUIDs and metadata in one go
          if (Array.isArray(data.data)) {
            data.data.forEach(video => {
              allUUIDs.add(video.uuid);
            });
          }
          
          // If we have enough videos or reached the end, stop fetching more pages
          if (data.data.length < count) break;
          
          // Respect rate limits
          await sleep(300);
        } catch (err) {
          console.error(`Fetch failed for ${currentInstance}:`, err);
          await sleep(500);
        }
      }
    });

    // Wait for all fetches to complete
    await Promise.all(fetchPromises);

    const newUUIDs = Array.from(allUUIDs).filter(uuid => !processedUUIDs.has(uuid));
    if (!newUUIDs.length) {
      console.log(`✅ ${currentInstance}: No new videos to process`);
      return;
    }

    console.log(`🔍 ${currentInstance}: Found ${newUUIDs.length} new videos to process`);
    
    // Process videos in batches using the more efficient endpoint
    fetchAndSaveMetadata(currentInstance, newUUIDs, processedUUIDs);
  });
  });
}
async function fetchAndSaveMetadata(currentInstance, uuids, processedSet) {
  try {
    let metadataList = await db.getMetadataList();
    let added = 0;

    const fetchNext = async (index = 0) => {
      if (index >= uuids.length) {
        const processed = processMetadataList(metadataList);
        await db.saveMetadataList(processed);
        console.log(`✅ ${currentInstance}: Added ${added} new videos`);
        return;
      }

      const uuid = uuids[index];
      if (processedSet.has(uuid)) {
        return fetchNext(index + 1);
      }

      try {
        const response = await fetch(`${currentInstance}/api/v1/videos/${uuid}`);
        
        if (!response.ok) {
          console.warn(`⚠️ ${currentInstance}: Skipping ${uuid}, status: ${response.status}`);
          processedSet.add(uuid);
          return fetchNext(index + 1);
        }

        const metadata = await response.json();
        const cleanedMetadata = cleanMetadata(metadata);
        cleanedMetadata.shortUUID = cleanedMetadata.shortUUID || uuid;
        cleanedMetadata.sourceInstance = currentInstance;
        
        metadataList.push(cleanedMetadata);
        processedSet.add(uuid);
        added++;

        // Save processed UUIDs to chrome.storage
        chrome.storage.local.set({
          processedUUIDs: Array.from(processedSet)
        }, () => {
          // Add delay between requests to avoid rate limiting
          setTimeout(() => fetchNext(index + 1), 500);
        });
        
      } catch (err) {
        console.warn(`❌ ${currentInstance}: Error ${uuid} - ${err.message}`);
        // Continue with next UUID after a short delay
        setTimeout(() => fetchNext(index + 1), 500);
      }
    };

    await fetchNext();
  } catch (error) {
    console.error("Error in fetchAndSaveMetadata:", error);
  }
}

function cleanMetadata(metadata) {
  const cleaned = {
    shortUUID: metadata.shortUUID,
    uuid: metadata.uuid,
    name: metadata.name,
    description: metadata.description,
    duration: metadata.duration,
    views: metadata.views,
    likes: metadata.likes,
    dislikes: metadata.dislikes,
    nsfw: metadata.nsfw,
    tags: metadata.tags,
    url: metadata.url,
    embedUrl: metadata.embedUrl,
    thumbnailPath: metadata.thumbnailPath,
    previewPath: metadata.previewPath,
    publishedAt: metadata.publishedAt,
    account: {
      name: metadata.account?.name,
      displayName: metadata.account?.displayName,
      url: metadata.account?.url
    },
    channel: metadata.channel ? {
      name: metadata.channel.name,
      displayName: metadata.channel.displayName,
      url: metadata.channel.url
    } : null
  };

  // Process video description for recommendation
  let tokens = [];
  
  // Add title tokens
  if (cleaned.name) {
    tokens.push(...tokenize(cleaned.name));
  }

  // Add tag tokens
  if (Array.isArray(cleaned.tags)) {
    cleaned.tags.forEach(tag => {
      if (typeof tag === 'string') {
        tokens.push(tag.toLowerCase());
      } else if (tag && tag.name) {
        tokens.push(tag.name.toLowerCase());
      }
    });
  }

  // Add description tokens
  if (cleaned.description) {
    const cleanDesc = stripLinks(cleaned.description);
    tokens.push(...tokenize(cleanDesc));
  }

  // Remove duplicates and empty tokens
  tokens = [...new Set(tokens)].filter(token => token && token.length > 1);

  // Add recommendation vector
  cleaned.Video_description_vector = {
    recommended_standard: {
      tokens: tokens
    }
  };

  return cleaned;
}
async function getMetadataList() {
  try {
    const db = await openDB();
    const tx = db.transaction("metadataList", "readonly");
    const store = tx.objectStore("metadataList");
    const request = store.getAll();
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    throw new Error(`Failed to get metadata list: ${error.message}`);
  }
}


function processMetadataList(metadataList) {
  // Remove duplicates based on shortUUID
  const seen = new Set();
  return metadataList.filter(item => {
    if (seen.has(item.shortUUID)) {
      return false;
    }
    seen.add(item.shortUUID);
    return true;
  });
}


// Alarms
chrome.runtime.onInstalled.addListener(() => {
  console.log("✅ Extension installed. Initializing...");
  chrome.alarms.create('metadataFetcher', { periodInMinutes: 3*60 });
  fetchVideoUUIDs(); // optional immediate fetch
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'metadataFetcher') {
    console.log("🔁 Running scheduled fetch...");
    fetchVideoUUIDs();
  }
});
// In background.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getMetadataList") {
    db.getMetadataList()
      .then(metadataList => {
        console.log("Sending metadata list to content script:", metadataList.length);
        sendResponse({ metadataList: metadataList });
      })
      .catch(error => {
        console.error("Error getting metadata list:", error);
        sendResponse({ error: error.message });
      });
    return true; // Will respond asynchronously
  }
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "saveMetadata") {
    const metadata = message.metadata;
    if (!metadata || !metadata.shortUUID) {
      return sendResponse({ success: false, error: "Invalid metadata format" });
    }
    saveMetadataToDB(metadata)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

async function saveMetadataToDB(metadata) {
  try {
    const db = await openDB();
    const tx = db.transaction("metadataList", "readwrite");
    const store = tx.objectStore("metadataList");
    await store.put(metadata); // ✅ No second argument
    await tx.done;
    console.log("Metadata saved to DB:", metadata.shortUUID);
    return true;
  } catch (error) {
    throw new Error(`Failed to save metadata: ${error.message}`);
  }
}

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("peertubeDB", 2); // Changed to version 2
    request.onerror = (event) => reject(event.target.error);
    request.onsuccess = (event) => resolve(event.target.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("metadataList")) {
        db.createObjectStore("metadataList", { keyPath: "shortUUID" });
      }
      // Add other schema changes here if needed for version 2
    };
  });
}

// Allow popup or content script to trigger fetch manually
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "manualFetch") {
    console.log("📦 Manual metadata fetch triggered");
    fetchVideoUUIDs();
  }
  
});
