"use strict";

const instanceUrl = 'https://peertube.1312.media/';
const count = 40;
const maxPages = 3;

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
    if (video.isLive || !video.name && !video.description) return video;

    let tokens = [];

    if (video.name) tokens.push(...tokenize(video.name));
    if (Array.isArray(video.tags)) {
      video.tags.forEach(tag => {
        if (tag?.name) tokens.push(tag.name.toLowerCase());
      });
    }
    if (video.description) tokens.push(...tokenize(stripLinks(video.description)));

    tokens = [...new Set(tokens)];

    video.Video_description_vector = video.Video_description_vector || {};
    video.Video_description_vector.recommended_standard = video.Video_description_vector.recommended_standard || {};
    video.Video_description_vector.recommended_standard.tokens = tokens;

    return video;
  });
}

// Fetch and save video metadata
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

  chrome.storage.local.get(['processedUUIDs'], async (result) => {
    const processedUUIDs = new Set(result.processedUUIDs || []);

    for (const template of apiUrlTemplates) {
      if (template === newestTemplate) {
        for (let start = 0; start < maxPages * count; start += count) {
          const url = template + `&start=${start}`;
          try {
            const response = await fetch(url);
            if (!response.ok) break;
            const data = await response.json();
            const uuids = Array.isArray(data.data) ? data.data.map(v => v.uuid) : [];
            if (!uuids.length) break;
            uuids.forEach(uuid => allUUIDs.add(uuid));
          } catch (err) {
            console.error("Fetch failed:", err);
            await sleep(500);
          }
        }
      } else {
        try {
          const response = await fetch(template + '&start=0');
          const data = await response.json();
          const uuids = Array.isArray(data.data) ? data.data.map(v => v.uuid) : [];
          uuids.forEach(uuid => allUUIDs.add(uuid));
        } catch (err) {
          console.error("Fetch failed:", err);
        }
      }
    }

    const newUUIDs = Array.from(allUUIDs).filter(uuid => !processedUUIDs.has(uuid));
    if (!newUUIDs.length) return;

    chrome.storage.local.set({ videoUUIDs: newUUIDs }, () => {
      fetchAndSaveMetadata(newUUIDs, processedUUIDs);
    });
  });
}

async function fetchAndSaveMetadata(uuids, processedSet) {
  chrome.storage.local.get(['metadataList'], (result) => {
    let metadataList = result.metadataList || [];

    const fetchNext = async (index = 0) => {
      if (index >= uuids.length) {
        const processed = processMetadataList(metadataList);
        chrome.storage.local.set({ metadataList: processed }, () => {
          console.log("✅ Metadata processed and saved.");
        });
        return;
      }

      const uuid = uuids[index];
      if (processedSet.has(uuid)) return fetchNext(index + 1);

      try {
        const response = await fetch(`${instanceUrl}/api/v1/videos/${uuid}`);
        if (!response.ok) throw new Error("Not found");

        const metadata = await response.json();
        metadata.shortUUID = metadata.shortUUID || uuid;
        metadataList.push(metadata);
        processedSet.add(uuid);

        chrome.storage.local.set({
          metadataList: metadataList,
          processedUUIDs: Array.from(processedSet)
        }, () => {
          fetchNext(index + 1);
        });
      } catch (err) {
        console.warn(`Error fetching metadata for ${uuid}:`, err.message);
        await sleep(500);
        fetchNext(index + 1);
      }
    };

    fetchNext();
  });
}

// Alarms
chrome.runtime.onInstalled.addListener(() => {
  console.log("✅ Extension installed. Initializing...");
  chrome.alarms.create('metadataFetcher', { periodInMinutes: 60 });
  fetchVideoUUIDs(); // optional immediate fetch
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'metadataFetcher') {
    console.log("🔁 Running scheduled fetch...");
    fetchVideoUUIDs();
  }
});

// Allow popup or content script to trigger fetch manually
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "manualFetch") {
    console.log("📦 Manual metadata fetch triggered");
    fetchVideoUUIDs();
  }
});
