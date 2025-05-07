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

// Improved DB functions with connection pooling
const db = {
  _connection: null,
  
  async getConnection() {
    if (this._connection) return this._connection;
    
    this._connection = await new Promise((resolve, reject) => {
      const request = indexedDB.open("peertubeDB", 2);
      request.onerror = (event) => reject(event.target.error);
      request.onsuccess = (event) => resolve(event.target.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("metadataList")) {
          db.createObjectStore("metadataList", { keyPath: "shortUUID" });
        }
      };
    });
    
    return this._connection;
  },
  
  async getMetadataList() {
    const db = await this.getConnection();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("metadataList", "readonly");
      const store = tx.objectStore("metadataList");
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },
  
  async saveMetadataBatch(metadataItems) {
    if (!metadataItems.length) return;
    
    const db = await this.getConnection();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("metadataList", "readwrite");
      const store = tx.objectStore("metadataList");
      
      let completed = 0;
      let errors = [];
      
      metadataItems.forEach(item => {
        const request = store.put(item);
        request.onsuccess = () => {
          completed++;
          if (completed === metadataItems.length) {
            resolve({ success: true, errors });
          }
        };
        request.onerror = (e) => {
          errors.push({ uuid: item.shortUUID, error: e.target.error });
          completed++;
          if (completed === metadataItems.length) {
            resolve({ success: true, errors });
          }
        };
      });
      
      tx.oncomplete = () => {
        console.log(`✅ Batch save complete: ${metadataItems.length} items`);
      };
      
      tx.onerror = (e) => {
        reject(e.target.error);
      };
    });
  }
};

// Helper functions
function stripLinks(text) {
  if (!text) return '';
  return text.replace(/https?:\/\/\S+|www\.\S+/g, "");
}

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(word => word.length > 1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanMetadata(metadata) {
  if (!metadata) return null;
  
  const cleaned = {
    shortUUID: metadata.shortUUID || metadata.uuid,
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
    account: metadata.account ? {
      name: metadata.account.name,
      displayName: metadata.account.displayName,
      url: metadata.account.url
    } : {},
    channel: metadata.channel ? {
      name: metadata.channel.name,
      displayName: metadata.channel.displayName,
      url: metadata.channel.url
    } : null,
    sourceInstance: metadata.sourceInstance
  };

  // Process video description for recommendation - do this once
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
    tokens.push(...tokenize(stripLinks(cleaned.description)));
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

// Function to clean existing metadata in storage
async function cleanExistingMetadata() {
  try {
    const metadataList = await db.getMetadataList();
    if (metadataList.length) {
      const cleanedList = metadataList.map(cleanMetadata).filter(Boolean);
      await db.saveMetadataBatch(cleanedList);
      console.log('✅ Cleaned existing metadata list');
      
      // Log storage usage
      chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
        console.log(`📊 Storage usage: ${(bytesInUse / 1024 / 1024).toFixed(2)} MB`);
      });
    }
  } catch (error) {
    console.error("Error cleaning metadata:", error);
  }
}

async function processAllInstances() {
  const allFetchPromises = [];
  for (const instance of instances) {
    allFetchPromises.push(fetchVideoUUIDs(instance));
    // Don't await here - push the promise to the array
  }
  
  // Now wait for all instances to complete (with proper error handling)
  const results = await Promise.allSettled(allFetchPromises);
  
  // Log results
  const successful = results.filter(r => r.status === 'fulfilled').length;
  console.log(`✅ Completed fetching from ${successful}/${instances.length} instances`);
  
  // Clean and optimize stored data
  await cleanExistingMetadata();
}

async function fetchVideoUUIDs(currentInstance) {
  try {
    // Get configuration settings
    const result = await new Promise(resolve => {
      chrome.storage.local.get(['hasRunBefore'], resolve);
    });
    const hasRunBefore = result.hasRunBefore;
    
    let count, maxPages;
    if (hasRunBefore) {
      count = 100;
      maxPages = 2;
    } else {
      count = 100;
      maxPages = 1;
      await new Promise(resolve => {
        chrome.storage.local.set({ hasRunBefore: true }, resolve);
      });
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
    
    // Get processed UUIDs from storage
    const processedResult = await new Promise(resolve => {
      chrome.storage.local.get(['processedUUIDs'], resolve);
    });
    const processedUUIDs = processedResult.processedUUIDs || [];
    const processedSet = new Set(processedUUIDs);
    
    // Collect UUIDs and metadata in parallel from all endpoints
    const endpointPromises = apiUrlTemplates.map(async (template) => {
      const videoData = []; // Store full video data for batch processing
      
      // For each template, fetch multiple pages
      for (let start = 0; start < maxPages * count; start += count) {
        const url = template + `&start=${start}`;
        try {
          const response = await fetch(url);
          if (!response.ok) break;
          const data = await response.json();
          
          if (Array.isArray(data.data)) {
            // Store both UUIDs and full metadata for later processing
            data.data.forEach(video => {
              allUUIDs.add(video.uuid);
              // Keep the full video object for batch processing
              videoData.push(video);
            });
          }
          
          // If we have enough videos or reached the end, stop fetching more pages
          if (data.data.length < count) break;
          
          // Respect rate limits
          await sleep(300);
        } catch (err) {
          console.error(`Fetch failed for ${currentInstance}:`, err);
        }
      }
      
      return videoData;
    });
    
    // Wait for all endpoint fetches to complete
    const allVideoDataArrays = await Promise.all(endpointPromises);
    
    // Combine and deduplicate video data
    const allVideoData = [];
    const seenUUIDs = new Set();
    
    allVideoDataArrays.flat().forEach(video => {
      if (!seenUUIDs.has(video.uuid)) {
        seenUUIDs.add(video.uuid);
        allVideoData.push(video);
      }
    });
    
    // Filter out videos we've already processed
    const newVideoData = allVideoData.filter(video => !processedSet.has(video.uuid));
    
    if (!newVideoData.length) {
      console.log(`✅ ${currentInstance}: No new videos to process`);
      return;
    }
    
    console.log(`🔍 ${currentInstance}: Found ${newVideoData.length} new videos to process`);
    
    // Process videos in efficient batches
    await fetchAndSaveMetadata(currentInstance, newVideoData, processedSet);
    
  } catch (error) {
    console.error(`Error processing ${currentInstance}:`, error);
  }
}

async function fetchAndSaveMetadata(currentInstance, videos, processedSet) {
  try {
    // Get current metadata list
    const existingMetadata = await db.getMetadataList();
    const existingUUIDs = new Set(existingMetadata.map(m => m.shortUUID));
    
    // Process videos in batches of 10 (adjust as needed)
    const BATCH_SIZE = 10;
    let processed = 0;
    
    for (let i = 0; i < videos.length; i += BATCH_SIZE) {
      const batch = videos.slice(i, i + BATCH_SIZE);
      const batchPromises = [];
      
      // Process each video in the batch concurrently
      for (const video of batch) {
        // Skip if already in our database
        if (existingUUIDs.has(video.shortUUID) || existingUUIDs.has(video.uuid)) {
          processedSet.add(video.uuid);
          continue;
        }
        
        // If we have enough data from the list endpoint, use that directly
        if (video.name && video.description !== undefined) {
          // We already have enough data to process
          const cleanedVideo = cleanMetadata({...video, sourceInstance: currentInstance});
          batchPromises.push(Promise.resolve(cleanedVideo));
          processedSet.add(video.uuid);
        } else {
          // Otherwise fetch the full video data
          batchPromises.push(
            fetch(`${currentInstance}/api/v1/videos/${video.uuid}`)
              .then(response => {
                if (!response.ok) {
                  console.warn(`⚠️ ${currentInstance}: Skipping ${video.uuid}, status: ${response.status}`);
                  processedSet.add(video.uuid);
                  return null;
                }
                return response.json();
              })
              .then(data => {
                if (!data) return null;
                const cleanedVideo = cleanMetadata({...data, sourceInstance: currentInstance});
                processedSet.add(video.uuid);
                return cleanedVideo;
              })
              .catch(err => {
                console.warn(`❌ ${currentInstance}: Error ${video.uuid} - ${err.message}`);
                return null;
              })
          );
        }
      }
      
      // Wait for all videos in this batch to be processed
      const processedVideos = (await Promise.all(batchPromises)).filter(Boolean);
      
      // Save the batch to IndexedDB
      if (processedVideos.length > 0) {
        await db.saveMetadataBatch(processedVideos);
        processed += processedVideos.length;
      }
      
      // Update processedUUIDs in chrome.storage
      await new Promise(resolve => {
        chrome.storage.local.set({
          processedUUIDs: Array.from(processedSet)
        }, resolve);
      });
      
      // Add a small delay between batches to avoid overwhelming the browser
      if (i + BATCH_SIZE < videos.length) {
        await sleep(300);
      }
    }
    
    console.log(`✅ ${currentInstance}: Added ${processed} new videos`);
    
  } catch (error) {
    console.error(`Error in fetchAndSaveMetadata for ${currentInstance}:`, error);
  }
}

// Initialization
chrome.runtime.onInstalled.addListener(() => {
  console.log("✅ Extension installed. Initializing...");
  chrome.alarms.create('metadataFetcher', { periodInMinutes: 60 });
  processAllInstances();
});

// Alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'metadataFetcher') {
    console.log("🔁 Running scheduled fetch...");
    processAllInstances();
  }
});

// Message handlers for content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getMetadataList") {
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
  
  if (message.action === "saveMetadata") {
    const metadata = message.metadata;
    if (!metadata || !metadata.shortUUID) {
      return sendResponse({ success: false, error: "Invalid metadata format" });
    }
    
    // Optimize by using the batch save for single items too
    db.saveMetadataBatch([cleanMetadata(metadata)])
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
  
  if (message.action === "manualFetch") {
    console.log("📦 Manual metadata fetch triggered");
    processAllInstances();
    sendResponse({ success: true });
    return false;
  }
});