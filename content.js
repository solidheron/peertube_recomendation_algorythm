let currentSession = null;
let ctrlPressed = false;
let shiftPressed = false;
let lastSaveTime = 0;
const interval = 1; // interval in seconds
const knownInstances = [
  'https://dalek.zone',
  'https://peertube.1312.media',
  'https://peertube.mastodon.host',
  'https://video.blender.org',
  'https://tilvids.com',
  'https://peertube.tangentfox.com',
  'https://video.hardlimit.com'
];
// Initialize variables
let currentURL = window.location.href; // Initialize currentURL
let data = null; // Initialize data as null
let prev = []; // Initialize as empty array

// Function to initialize or reset data - updated to accept current timestamp
function initializeData(currentVideoTime = 0) {
  return {
    title: document.title,
    url: currentURL,
    currentTime: currentVideoTime,
    duration: 0,
    percentWatched: 0,
    watchedLiveSeconds: 0,
    isLive: false,
    liked: false,
    disliked: false,
    last_update: new Date().toISOString(),
    session: {
      segments: []
    },
    sessionStart: currentVideoTime, // Initialize with current video time
    finished: false
  };
}

function tokenize(text) {
    const tokens = text
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter(word => word.length > 1);
    return tokens;
}


async function createUserRecommendationVector(peertubeWatchHistory) {
  try {
    // Fetch existing metadataList from background script
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "getMetadataList" },
        (response) => resolve(response)
      );
    });

    let metadataList = response?.metadataList || [];
    if (!Array.isArray(metadataList)) {
      metadataList = [];
      console.warn("Invalid metadataList format. Using empty array.");
    }
    console.log(`Retrieved ${metadataList.length} metadata items from DB`);

    // Fetch missing metadata
    const fetchedMetadata = [];

    for (const watchEntry of peertubeWatchHistory) {
      if (!watchEntry.url) continue;

      const shortUUID = extractShortUUIDFromURL(watchEntry.url);
      if (!shortUUID) continue;

      // Check if metadata already exists in metadataList
      const existingMetadata = metadataList.find(
        (item) => item.shortUUID === shortUUID
      );
      if (existingMetadata) {
        //console.log(`Metadata for ${shortUUID} already exists. Skipping.`);
        continue; // Skip if already present
      }

      // Fetch missing metadata
      const metadata = await fetchMissingMetadata(shortUUID, watchEntry);
      if (metadata) {
        fetchedMetadata.push(metadata);
      } else {
        console.error(`Failed to fetch metadata for ${shortUUID}`);
      }
    }

    // Merge fetched metadata into metadataList
    if (fetchedMetadata.length > 0) {
      console.log(`Fetched ${fetchedMetadata.length} new metadata items`);
      metadataList = [...metadataList, ...fetchedMetadata];
    }

    // Initialize vectors for accumulating engagement
    const totalTokens = {
      time_engagement: {},
      like_engagement: {},
    };

    // Process each watched video
    let processedCount = 0;

    for (const watchEntry of peertubeWatchHistory) {
      if (!watchEntry.url) continue;

      const shortUUID = extractShortUUIDFromURL(watchEntry.url);
      if (!shortUUID) continue;

      const metadata = metadataList.find(
        (item) => item.shortUUID === shortUUID
      );
      if (!metadata) {
        console.warn(`⚠️ No metadata found for ${shortUUID}`);
        continue;
      }

      const tokens = metadata?.Video_description_vector?.recommended_standard?.tokens;
      if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
        console.warn(`⚠️ No valid tokens for ${shortUUID}`);
        continue;
      }

      const overlapWatchTime = watchEntry.overlap_watchtime || 0;
      let likeValue = 0;
      if (watchEntry.liked) likeValue = 1;
      else if (watchEntry.disliked) likeValue = -1;

      if (overlapWatchTime > 0 || likeValue !== 0) {
        tokens.forEach((token) => {
          if (typeof token === "string" && token.trim()) {
            const cleanToken = token.trim();

            // Add time engagement
            if (overlapWatchTime > 0) {
              totalTokens.time_engagement[cleanToken] =
                (totalTokens.time_engagement[cleanToken] || 0) + overlapWatchTime;
            }

            // Add like engagement
            if (likeValue !== 0) {
              totalTokens.like_engagement[cleanToken] =
                (totalTokens.like_engagement[cleanToken] || 0) + likeValue;
            }
          }
        });
        processedCount++;
      }
    }

    console.log(`Processed ${processedCount} videos with engagement`);
    console.log(
      "Time engagement tokens:",
      Object.keys(totalTokens.time_engagement).length
    );
    console.log(
      "Like engagement tokens:",
      Object.keys(totalTokens.like_engagement).length
    );

    // Create the final vector
    const enhancedVector = [
      {
        total: {
          time_engagement: totalTokens.time_engagement,
          like_engagement: totalTokens.like_engagement,
        },
      },
    ];

    return enhancedVector;

  } catch (error) {
    console.error("Error in createUserRecommendationVector:", error);
    return [
      {
        total: {
          time_engagement: {},
          like_engagement: {},
        },
      },
    ];
  }
}

// Helper function to extract shortUUID from URL
function extractShortUUIDFromURL(url) {
  try {
    const regex = /(?:\/videos\/watch\/|\/w\/|\/v\/)([a-zA-Z0-9\-_]+)/;
    const match = url.match(regex);
    return match ? match[1] : null;
  } catch (error) {
    console.error("Error extracting UUID from URL:", error);
    return null;
  }
}

// Function to trigger vector creation and update
async function updateUserVector() {
  try {
    console.group("🔄 Updating User Vector");
    
    const result = await new Promise(resolve => 
      chrome.storage.local.get(['peertubeWatchHistory'], resolve)
    );
    
    const watchHistory = Array.isArray(result.peertubeWatchHistory) 
      ? result.peertubeWatchHistory 
      : [];
    
    console.log("Watch history entries:", watchHistory.length);
    
    if (watchHistory.length === 0) {
      console.warn("Watch history is empty");
      console.groupEnd();
      return;
    }
    
    const userVector = await createUserRecommendationVector(watchHistory);
    
    console.log("Saving user vector:", userVector);
    
    // Check if vector has content
    const hasTimeEngagement = Object.keys(userVector[0]?.total?.time_engagement || {}).length > 0;
    const hasLikeEngagement = Object.keys(userVector[0]?.total?.like_engagement || {}).length > 0;
    
    console.log("Vector has time engagement:", hasTimeEngagement);
    console.log("Vector has like engagement:", hasLikeEngagement);
    
    if (!hasTimeEngagement && !hasLikeEngagement) {
      console.warn("Vector is empty, not saving");
      console.groupEnd();
      return;
    }
    
    // Save to storage
    await new Promise(resolve => 
      chrome.storage.local.set({ userRecommendationVector: userVector }, resolve)
    );
    
    console.log("User vector saved successfully");
    
    // Verify it was saved correctly
    const verification = await new Promise(resolve => 
      chrome.storage.local.get(['userRecommendationVector'], resolve)
    );
    
    console.log("Verification:", verification);
    console.groupEnd();
    
    // Now compute cosine similarity
    await computeAndStoreCosineSimilarity();
    
  } catch (error) {
    console.error("Error in updateUserVector:", error);
    console.groupEnd();
  }
}




// Helper function to fetch video info and update metadata
async function fetchVideoInfoAndUpdateMetadata(shortUUID) {
  const instances =  knownInstances

  for (const instance of instances) {
    try {
      const response = await fetch(`${instance}/api/v1/videos/${shortUUID}`);
      if (!response.ok) continue;

      const metadata = await response.json();
      const processedMetadata = processVideoMetadata({
        ...metadata,
        shortUUID,
        sourceInstance: instance
      });

      return processedMetadata;

    } catch (error) {
      console.warn(`Failed to fetch from ${instance}:`, error);
      continue;
    }
  }
  return null;
}

// Helper function to process video metadata
function processVideoMetadata(video) {
  let tokens = [];
  
  if (video.name) {
    tokens.push(...tokenize(video.name));
  }

  if (Array.isArray(video.tags)) {
    video.tags.forEach(tag => {
      if (tag && typeof tag === 'string') {
        tokens.push(tag.toLowerCase());
      } else if (tag && tag.name) {
        tokens.push(tag.name.toLowerCase());
      }
    });
  }

  if (video.description) {
    const cleanDesc = stripLinks(video.description);
    tokens.push(...tokenize(cleanDesc));
  }

  // Remove duplicates and empty tokens
  tokens = [...new Set(tokens)].filter(token => token && token.length > 1);
  
  video.Video_description_vector = {
    recommended_standard: {
      tokens: tokens
    }
  };
  
  return video;
}

// Sleep helper function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
chrome.storage.local.get(['cosine_similarity', 'preferredInstance'], (result) => {
  const data = result.cosine_similarity || [];
  const preferredInstance = result.preferredInstance || '';
  const tbody = document.querySelector('#results tbody');
	if (!tbody) {
	  //console.warn('No #results tbody found in the DOM.');
	  return;
	}
  tbody.innerHTML = '';
	data.forEach(entry => {
    const row = document.createElement('tr');

    const videoLink = `<a href="${entry.url}" target="_blank">${entry.url}</a>`;
    const altLink = preferredInstance
      ? `<a href="${preferredInstance}/w/${entry.shortUUID}" target="_blank">${preferredInstance}/w/${entry.shortUUID}</a>`
      : '(not set)';

    row.innerHTML = `
      <td>${entry.time_engagement_similarity}</td>  // Changed from similarity to time_engagement_similarity
      <td>${videoLink}</td>
      <td>${altLink}</td>
    `;

    tbody.appendChild(row);
  });
});


// Function to fetch video info by shortUUID
function fetchVideoInfoByShortUUID(shortUUID) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['instanceUrl'], (result) => {
            const instanceUrl = result.instanceUrl || 'https://dalek.zone/';
            const videoApiUrl = `${instanceUrl.replace(/\/$/, '')}/api/v1/videos/${shortUUID}`;

            fetch(videoApiUrl)
                .then(response => {
                    if (!response.ok) {
                        if (response.status === 404) {
                            console.warn(`Video ${shortUUID} not found on instance. Returning null.`);
                            resolve(null);  // Resolve with null for 404
                        } else {
                            reject(new Error(`Failed to fetch video info for ${shortUUID}: ${response.statusText}`));
                        }
                    }
                    return response.json();
                })
                .then(data => {
                    resolve(data);
                })
                .catch(error => {
                    console.error(`Error fetching video info for ${shortUUID}:`, error);
                    reject(error);
                });
        });
    });
}

// Add these functions to your content.js file

function cleanMetadata(metadata) {
  // Extract only the fields we need
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

function stripLinks(text) {
  return text.replace(/https?:\/\/\S+|www\.\S+/g, "");
}

async function fetchMissingMetadata(shortUUID, watchEntry = null) {
  console.log(`🔍 Fetching missing metadata for ${shortUUID}...`);

  let sourceInstance = null;
  if (watchEntry && watchEntry.url) {
    try {
      const urlObj = new URL(watchEntry.url);
      sourceInstance = `${urlObj.protocol}//${urlObj.hostname}`;
      console.log(`Extracted source instance from URL: ${sourceInstance}`);
    } catch (e) {
      console.warn(`Could not extract instance from URL: ${watchEntry.url}`);
    }
  }

 const instances = Array.from(new Set([
  ...(sourceInstance ? [sourceInstance] : []),
  ...knownInstances
]));

  for (const instance of instances) {
    try {
      console.log(`Trying ${instance} for ${shortUUID}...`);
      const response = await fetch(`${instance}/api/v1/videos/${shortUUID}`);
      
      if (response.ok) {
        const data = await response.json();
        console.log(`✅ Found metadata for ${shortUUID} on ${instance}`);
        
        try {
          // Process metadata
          const metadata = cleanMetadata(data);
          if (!metadata) {
            console.error("Invalid metadata after processing:", data);
            continue; // Skip invalid metadata
          }
          metadata.shortUUID = shortUUID;
          metadata.sourceInstance = instance;
          
          // Save to database via background script
          await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { 
                action: "saveMetadata", 
                metadata: metadata 
              },
              (response) => {
                if (response?.success) {
                  resolve();
                } else {
                  reject(new Error(response?.error || "Save failed"));
                }
              }
            );
          });
          
          console.log(`✅ Saved metadata for ${shortUUID}`);
          return metadata;
        } catch (processError) {
          console.error(`Error processing metadata for ${shortUUID}:`, processError);
        }
      }
    } catch (error) {
      console.warn(`Error fetching from ${instance} for ${shortUUID}:`, error);
    }
  }

  // If all fails, create a minimal metadata entry
  console.warn(`⚠️ Could not fetch metadata for ${shortUUID}, creating minimal entry`);
  
  const minimalMetadata = {
    shortUUID: shortUUID,
    name: `Unknown Video (${shortUUID})`,
    description: "Metadata unavailable",
    Video_description_vector: {
      recommended_standard: {
        tokens: ["unknown", "video", "unavailable"]
      }
    },
    unavailable: true
  };
  
  // Save minimal metadata
  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { 
          action: "saveMetadata", 
          metadata: minimalMetadata 
        },
        (response) => {
          if (response?.success) {
            resolve();
          } else {
            reject(new Error(response?.error || "Save failed"));
          }
        }
      );
    });
    return minimalMetadata;
  } catch (error) {
    console.error("Failed to save minimal metadata:", error);
    return null; // Return null if even minimal save fails
  }
}

// Function to store enhanced user recommendation vector
function storeUserRecommendationVector() {
    chrome.storage.local.get(['peertubeWatchHistory'], (result) => {
        const peertubeWatchHistory = result.peertubeWatchHistory ? JSON.parse(result.peertubeWatchHistory) : [];

        createUserRecommendationVector(peertubeWatchHistory)
            .then(enhancedVector => {
                chrome.storage.local.set({
                    userRecommendationVector: JSON.stringify(enhancedVector)
                }, () => {
                    console.log('âœ… userRecommendationVector stored.');
                    computeAndStoreCosineSimilarity(); // Call your new similarity function here
                });
            });
    });
}

async function computeAndStoreCosineSimilarity() {
  try {
    console.group("📊 Computing cosine similarity");

    // 1. Load user vector
    const userResult = await new Promise(resolve =>
      chrome.storage.local.get(['userRecommendationVector'], resolve)
    );

    let userVector = userResult.userRecommendationVector;
    if (typeof userVector === 'string') userVector = JSON.parse(userVector);

    if (!Array.isArray(userVector) || userVector.length === 0) {
      console.warn("⚠️ Empty user vector");
      console.groupEnd();
      return;
    }

    const totalEntry = userVector.find(e => e.total);
    const timeVec = totalEntry?.total?.time_engagement || {};
    const LikeVec = totalEntry?.total?.like_engagement || {};

    if (Object.keys(timeVec).length === 0 && Object.keys(LikeVec).length === 0) {
      console.warn("⚠️ Both time and like engagement vectors are empty");
      console.groupEnd();
      return;
    }

    // 2. Precompute norms
    const userTimeNorm = Math.sqrt(
      Object.values(timeVec).reduce((sum, v) => sum + v * v, 0)
    );
    const userLikeNorm = Math.sqrt(
      Object.values(LikeVec).reduce((sum, v) => sum + v * v, 0)
    );

    // 3. Load video metadata
    const metaResult = await new Promise(resolve =>
      chrome.runtime.sendMessage({ action: "getMetadataList" }, resolve)
    );

    const metadataList = Array.isArray(metaResult?.metadataList) ? metaResult.metadataList : [];
    if (metadataList.length === 0) {
      console.warn("⚠️ No metadata found");
      console.groupEnd();
      return;
    }

    const timeTokens = Object.keys(timeVec);
    const likeTokens = Object.keys(LikeVec);
    const results = [];

    // 4. Loop through videos in chunks
    for (let i = 0; i < metadataList.length; i++) {
      const video = metadataList[i];
      if (!video?.shortUUID || !Array.isArray(video?.Video_description_vector?.recommended_standard?.tokens)) {
        continue;
      }

      // 5. Reuse or build binary vector + norm
      if (!video._vector || !video._norm) {
        const vector = {};
        const tokens = video.Video_description_vector.recommended_standard.tokens;
        for (const t of tokens) {
          if (typeof t === 'string' && t.trim()) {
            vector[t.trim()] = 1;
          }
        }
        video._vector = vector;
        video._norm = Math.sqrt(Object.keys(vector).length); // assuming all 1s
      }

      // 6. Compute dot products
      let timeDot = 0;
      for (const token of timeTokens) {
        if (video._vector[token]) {
          timeDot += timeVec[token];
        }
      }

      let likeDot = 0;
      for (const token of likeTokens) {
        if (video._vector[token]) {
          likeDot += LikeVec[token];
        }
      }

      const timeSim = (userTimeNorm && video._norm) ? timeDot / (userTimeNorm * video._norm) : 0;
      const likeSim = (userLikeNorm && video._norm) ? likeDot / (userLikeNorm * video._norm) : 0;

      results.push({
        shortUUID: video.shortUUID,
        url: video.url,
        name: video.name,
        tokens: {
          time_engagement_similarity: Number(timeSim.toFixed(4)),
          like_engagement_similarity: Number(likeSim.toFixed(4))
        }
      });

      if (i % 50 === 0) await new Promise(r => setTimeout(r, 0)); // Yield
    }

    // 7. Sort by time engagement similarity (or choose composite sorting later)
    results.sort((a, b) =>
      b.tokens.time_engagement_similarity - a.tokens.time_engagement_similarity
    );

    // 8. Save results
    await new Promise(resolve =>
      chrome.storage.local.set({ cosine_similarity: results }, resolve)
    );

    console.log(`✅ Saved ${results.length} similarity results`);
    console.groupEnd();

  } catch (err) {
    console.error("❌ Error in computeAndStoreCosineSimilarity:", err);
    console.groupEnd();
  }
}

// Helper function to calculate cosine similarity
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB) return 0;
  const keysA = Object.keys(vecA);
  const keysB = Object.keys(vecB);
  if (keysA.length === 0 || keysB.length === 0) return 0;

  let dotProduct = 0, normA = 0, normB = 0;
  for (const key of keysA) {
    const valA = vecA[key] || 0;
    const valB = vecB[key] || 0;
    dotProduct += valA * valB;
    normA += valA * valA;
  }
  for (const key of keysB) {
    const valB = vecB[key] || 0;
    normB += valB * valB;
  }
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (normA * normB);
}

// Function to trigger the cosine similarity calculation
async function updateRecommendations() {
  try {
    console.log("Starting recommendation update...");
    
    // First, ensure we have the latest metadata
    const metadataList = await db.getMetadataList();
    console.log(`Found ${metadataList.length} videos in metadata`);
    
    // Then compute cosine similarity
    await computeAndStoreCosineSimilarity();
    
    console.log("Recommendation update complete");
  } catch (error) {
    console.error("Error updating recommendations:", error);
  }
}

// Add this to your message listener in content.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "updateRecommendations") {
    updateRecommendations()
      .then(() => sendResponse({status: "success"}))
      .catch(error => sendResponse({status: "error", message: error.toString()}));
    return true;  // Will respond asynchronously
  }
});
// Cosine similarity function

// In content.js, after loading watch history
function processWatchHistory() {
  chrome.storage.local.get(['peertubeWatchHistory'], async (result) => {
    const watchHistory = Array.isArray(result.peertubeWatchHistory) 
      ? result.peertubeWatchHistory 
      : [];
    
    console.log("Processing watch history:", watchHistory);
    
    if (watchHistory.length === 0) {
      console.warn("Watch history is empty");
      return;
    }

    try {
      const userVector = await createUserRecommendationVector(watchHistory);
      
      chrome.storage.local.set({ userRecommendationVector: userVector }, () => {
        console.log("User recommendation vector saved");
        computeAndStoreCosineSimilarity();
      });
    } catch (error) {
      console.error("Error processing watch history:", error);
    }
  });
}
// Function to load watch history and initialize data for current video
function loadWatchHistory(callback) {
  chrome.storage.local.get(['peertubeWatchHistory'], (result) => {
    if (result.peertubeWatchHistory) {
      try {
        prev = JSON.parse(result.peertubeWatchHistory);
        if (!Array.isArray(prev)) {
          prev = [];
        }

        const existingData = prev.find(item => item.url === currentURL);

        if (existingData) {
          console.log('Found existing data for current URL:', existingData);
          data = existingData;
        } else {
          data = initializeData(0); // default start
          console.log('No existing data found for current URL. Initializing data with default values.');
        }

        // 🔍 Auto-repair segments only for isLive: false entries
        const historyWithoutLatest = prev.slice(0, -1);
        let modified = false;

        historyWithoutLatest.forEach((entry, index) => {
          if (!entry || entry.isLive || !entry.session || !Array.isArray(entry.session.segments)) return;

          const segments = entry.session.segments;
          const sessionStart = entry.sessionStart;
          const currentTime = entry.currentTime;

          const matched = segments.some(seg => {
            const isStartMatch = Math.abs(seg.start - sessionStart) < 0.1;
            const isEndMatch = Math.abs(seg.end - currentTime) < 0.1;
            return isStartMatch && isEndMatch;
          });

          if (!matched && sessionStart !== undefined && currentTime !== undefined) {
            const segDuration = parseFloat((currentTime - sessionStart).toFixed(2));
            const newSegment = {
              start: sessionStart,
              end: currentTime,
              seg_duration: segDuration,
              timestamp: new Date().toISOString()
            };

            entry.session.segments.push(newSegment);
            //console.warn(`🛠️ Auto-added missing segment for entry ${index} (${entry.url})`);
            modified = true;
          }
        });

        if (modified) {
          chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
            console.log("💾 Updated peertubeWatchHistory with repaired segments.");
          });
        }

      } catch (e) {
        console.error('Error parsing watch history:', e);
        prev = [];
        data = initializeData(0);
      }
    } else {
      prev = [];
      data = initializeData(0);
      console.log('No watch history found in storage. Initializing data with default values.');
    }

    main();
    callback();
    storeUserRecommendationVector();
  });
}



// Also update URL change handling to respect the 100ms play time check
setInterval(() => {
    if (window.location.href !== lastURL) {
        console.log("URL changed from", lastURL, "to", window.location.href);
        lastURL = window.location.href;
        currentURL = window.location.href;
        
        // Reset play timer since we've changed pages
        videoPlayStartTime = null;
        
        // Get current video timestamp if video exists and has enough data
        const video = document.querySelector("video");
        const currentVideoTime = (video && video.readyState >= 3) ? video.currentTime : 0;
        
        // Re-initialize data for the new URL with current video time as a default
        // But actual sessionStart will be set after 100ms of play
        data = initializeData(0); 

        const existingIndex = prev.findIndex(item => item.url === currentURL);
        if (existingIndex === -1) {
            prev.push(data);
        }

        loadWatchHistory(() => {
            console.log("Watch history loaded/reloaded after URL change.");
            // sessionStart will be set in setupTracking with the 100ms check
        });
    }
}, 1000);


// --- URL CHANGE DETECTION ---
let lastURL = window.location.href;
setInterval(() => {
    if (window.location.href !== lastURL) {
        console.log("URL changed from", lastURL, "to", window.location.href);
        lastURL = window.location.href;
        currentURL = window.location.href;

        // Delay re-initialization of data
        setTimeout(() => {
            const video = document.querySelector("video");
            const currentVideoTime = (video && video.readyState >= 3) ? video.currentTime : 0;
            data = initializeData(currentVideoTime);

            const existingIndex = prev.findIndex(item => item.url === currentURL);
            if (existingIndex === -1) {
                prev.push(data);
            }

            loadWatchHistory(() => {
                console.log("Watch history loaded/reloaded after URL change.");
                const video = document.querySelector("video");
                if (video && video.readyState >= 3) {
                    data.sessionStart = video.currentTime;

                    if (!video.paused && currentSession === null) {
                        currentSession = {
                            start: video.currentTime,
                            lastRecordedTime: video.currentTime
                        };
                        console.log("⚡ Initialized session with current video timestamp:", video.currentTime);
                    }
                }
            });
        }, 500); // Delay of 500 milliseconds
    }
}, 1000);

loadWatchHistory(() => {
    console.log("Initial watch history loaded.");
});

// Variable to store the previous current time for regular videos
let previousCurrentTime = 0;

// Variable to track if the video is playing
let isVideoPlaying = false;


// Performance monitoring variables
let executionTimes = [];


// Function to fetch PeerTube video info synchronously using its API
function fetchVideoInfoSync(videoUrl) {
  try {
    const videoIdMatch = videoUrl.mat
        //const videoIdMatch = videoUrl.match(/(?:\/videos\/watch\/|\/w\/)([a-zA-Z0-9\-_]+)/);
        if (!videoIdMatch) {
            console.warn("âŒ Could not extract video ID from URL:", videoUrl);
            return null;
        }

        const videoId = videoIdMatch[1];
        const apiUrl = `${window.location.origin}/api/v1/videos/${videoId}`;
        const xhr = new XMLHttpRequest();
        xhr.open("GET", apiUrl, false);
        xhr.send(null);

        if (xhr.status === 200) {
            return JSON.parse(xhr.responseText);
        } else {
            console.error("âŒ Failed to fetch video info from PeerTube API:", xhr.status);
            return null;
        }
    } catch (error) {
        console.error("âŒ Error fetching video info:", error);
        return null;
    }
}
function deduplicateSegments(segments) {
    return segments.filter((seg, index, self) =>
        index === self.findIndex(s =>
            Math.abs(s.start - seg.start) < 0.001 && Math.abs(s.end - seg.end) < 0.001
        )
    );
}

// Function to calculate drift and adjust timing
function adjustInterval(targetInterval) {
    const averageExecutionTime = executionTimes.length > 0 ? executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length : 0;
    let drift = averageExecutionTime - targetInterval * 1000; // drift in milliseconds
    // Limit the adjustment to a reasonable range to avoid over-correction
    let adjustment = Math.max(Math.min(drift, 100), -100);
    return targetInterval * 1000 - adjustment;
}

// Update the session segments for a regular video.
// For regular videos only, since live streams won't record segments.
function updateSession(video) {
    if (!video || video.readyState < 3) return null;
    const time = video.currentTime;
    const playbackRate = video.playbackRate || 1;

    // If the video has jumped backward, adjust the session start.
    if (currentSession !== null && time < currentSession.start) {
        currentSession.start = time;
        console.log("⏪ Video jumped back. Updating session start to:", time);
    }

    // If the video is paused, finish the current segment.
    if (video.paused) {
        isVideoPlaying = false;
        if (currentSession !== null) {
            if (currentSession.start !== undefined && currentSession.lastRecordedTime !== undefined) {
                const segDuration = currentSession.lastRecordedTime - currentSession.start;
                if (segDuration > 0.1) {
                    if (!data.session) data.session = { segments: [] };
                    if (!data.session.segments) data.session.segments = [];
                    const segmentExists = data.session.segments.some(segment => {
                        const sameStart = Math.abs(segment.start - currentSession.start) < 0.1;
                        const sameEnd = Math.abs(segment.end - currentSession.lastRecordedTime) < 0.1;
                        return sameStart && sameEnd;
                    });
                    if (!segmentExists) {
                        data.session.segments.push({
                            start: currentSession.start,
                            end: currentSession.lastRecordedTime,
                            seg_duration: segDuration,
                            timestamp: new Date().toISOString()
                        });
                    }

                    data.sessionStart = currentSession.start;
                    currentSession = null;
                }
            }
            return null;
        }
    } else {
        // Video is playing.
        isVideoPlaying = true;
        // Increase tolerance (in seconds) to prevent creating multiple segments during continuous playback.
        let tolerance = (interval + 2) * playbackRate;
        if (currentSession === null) {
            currentSession = {
                start: time,
                lastRecordedTime: time
            };
            // Update the sessionStart field immediately when a new session starts
            data.sessionStart = time;
        } else {
            const gap = time - currentSession.lastRecordedTime;
            if (gap > tolerance && gap > 1) {
                const segDuration = currentSession.lastRecordedTime - currentSession.start;
                if (segDuration > 0.1) {
                    if (!data.session) data.session = { segments: [] };
                    if (!data.session.segments) data.session.segments = [];
                    const segmentExists = data.session.segments.some(segment => {
                        const sameStart = Math.abs(segment.start - currentSession.start) < 0.1;
                        const sameEnd = Math.abs(segment.end - currentSession.lastRecordedTime) < 0.1;
                        return sameStart && sameEnd;
                    });
                    if (!segmentExists) {
                        data.session.segments.push({
                            start: currentSession.start,
                            end: currentSession.lastRecordedTime,
                            seg_duration: segDuration,
                            timestamp: new Date().toISOString()
                        });
                    }

                    // Start a new session segment.
                    currentSession = {
                        start: time,
                        lastRecordedTime: time
                    };
                    // Update sessionStart with the new session's start time
                    data.sessionStart = time;
                }
            } else {
                // Just update sessionStart with the current session's start time
                data.sessionStart = currentSession.start;
            }
            currentSession.lastRecordedTime = time;
            return currentSession;
        }
    }
    return null;
}

function saveWatchData(isFinalSave = false) {
    const startTime = performance.now();
    const now = Date.now();
    const deltaSeconds = (now - lastSaveTime) / 1000;
    if (!isFinalSave && (now - lastSaveTime < interval * 1000)) return;
    lastSaveTime = now;

    const video = document.querySelector("video");
    if ((!video || video.readyState < 3) && !isFinalSave) return;

    // Skip saving if not on a video URL to prevent errors on other pages
    if (!window.location.href.includes("/w/") && !window.location.href.includes("/videos/watch/")) {
        console.log("Skipping non-video URL:", window.location.href);
        return;
    }

    // For live streams, use the elapsed time if the video is playing
    if (data.isLive) {
        // Only add to watchedLiveSeconds if video is currently playing and has enough data
        if (video && !video.paused && video.readyState >= 3) {
            // Add the elapsed time since last save to watchedLiveSeconds
            data.watchedLiveSeconds += deltaSeconds;
            console.log(`🔴 Live stream watched for ${deltaSeconds.toFixed(2)} more seconds, total: ${data.watchedLiveSeconds.toFixed(2)}s`);
            
            // For live streams, set sessionStart to 0 when playing
            if (data.sessionStart === null) {
                data.sessionStart = 0;
            }
        }
        
        // Update title and URL (in case they changed)
        data.title = document.title;
        data.url = window.location.href;
        data.last_update = new Date().toISOString();
        
        // Check if entry already exists in prev array
        const existingIndex = prev.findIndex(item => item.url === data.url);
        if (existingIndex !== -1) {
            prev[existingIndex] = data;
        } else {
            prev.push(data);
        }
        
        // Save the entire prev array to storage
        chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
            if (chrome.runtime.lastError) {
                console.error("Error saving live watch data:", chrome.runtime.lastError);
            } else {
                console.log(`🔴 Live watch data saved (${data.watchedLiveSeconds.toFixed(2)}s watched)`);
            }
        });
        return;
    }

    // For regular videos:
    if (video && video.duration === 0) return;
    if (video && video.currentTime === previousCurrentTime && !isVideoPlaying) {
        //console.log("⭐️ Current time hasn't changed and video is paused. Skipping data saving.");
        return;
    }

    if (video) previousCurrentTime = video.currentTime;
    updateSession(video);
    if (data.session && Array.isArray(data.session.segments)) {
        data.session.segments = deduplicateSegments(data.session.segments);
    }

    const likeButton = document.querySelector("button.action-button-like");
    const dislikeButton = document.querySelector("button.action-button-dislike");
    const liked = likeButton ? likeButton.classList.contains("activated") : null;
    const disliked = dislikeButton ? dislikeButton.classList.contains("activated") : null;
    let totalSegDuration = 0;
    if (data.session?.segments) {
        data.session.segments.forEach(segment => {
            totalSegDuration += segment.seg_duration || 0;
        });
    }

    // Calculate overlap_watchtime
    function mergeSegments(segments) {
        if (!segments || segments.length === 0) return [];

        const sorted = segments
            .slice()
            .sort((a, b) => a.start - b.start);

        const merged = [sorted[0]];

        for (let i = 1; i < sorted.length; i++) {
            const last = merged[merged.length - 1];
            const current = sorted[i];

            if (current.start <= last.end + 0.1) { // Slight fuzziness to catch near overlaps
                last.end = Math.max(last.end, current.end);
            } else {
                merged.push({ ...current });
            }
        }

        return merged;
    }

    const mergedSegments = mergeSegments(data.session?.segments);
    const overlapWatchTime = mergedSegments.reduce((sum, s) => sum + (s.end - s.start), 0);

    // Save new fields
    data.totalSegDuration = parseFloat(totalSegDuration.toFixed(2));
    data.overlap_watchtime = parseFloat(overlapWatchTime.toFixed(2));

    data.title = document.title;
    data.url = window.location.href;
    if (video && video.readyState >= 3) {
        data.currentTime = video.currentTime;
        data.duration = video.duration;

        if (video.duration > 0) {
            data.percentWatched = parseFloat(((totalSegDuration / video.duration) * 100).toFixed(2));
            data.finished = (video.currentTime / video.duration) > 0.95;
        } else {
            data.percentWatched = 0;
            data.finished = false;
        }
    }
    data.liked = liked;
    data.disliked = disliked;
    data.last_update = new Date().toISOString();

    // Update the existing entry in prev array
    const existingIndex = prev.findIndex(item => item.url === data.url);
    if (existingIndex !== -1) {
        prev[existingIndex] = data;
    } else {
        prev.push(data);
    }

    // Use chrome.storage.local to save the entire updated array
    chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
        if (chrome.runtime.lastError) {
            console.error("Error saving watch data:", chrome.runtime.lastError);
        } else {
            console.log("📺 Watch data saved to chrome.storage.local:", data);
        }
    });

    const endTime = performance.now();
    const executionTime = endTime - startTime;
    executionTimes.push(executionTime);
    if (executionTimes.length > 10) {
        executionTimes.shift(); // Keep only the last 10 execution times
    }
}

// Add this new function to verify storage is working properly
// Store your interval ID so you can clear it
let storageVerificationInterval = null;

// Update your verification function with error handling
function verifyStorage() {
    return new Promise((resolve, reject) => {
        try {
            // Check if extension context is still valid
            if (!chrome.runtime || !chrome.runtime.id) {
                console.log("Extension context invalidated - reloading page");
                window.location.reload();
                return resolve(false);
            }

            chrome.storage.local.get(['peertubeWatchHistory'], result => {
                if (chrome.runtime.lastError) {
                    console.error("Storage error:", chrome.runtime.lastError);
                    return resolve(false);
                }
                resolve(true);
            });
        } catch (error) {
            console.error("Error in verifyStorage:", error);
            if (error.message.includes("Extension context invalidated")) {
                window.location.reload();
            }
            resolve(false);
        }
    });
}

// Replace your current setInterval with this:
function startStorageVerification() {
  if (storageVerificationInterval) {
    clearInterval(storageVerificationInterval);
  }
  
  storageVerificationInterval = setInterval(verifyStorage, 10*60000); // Check every minute
  
  // Also clear interval when page unloads
  window.addEventListener('beforeunload', function() {
    if (storageVerificationInterval) {
      clearInterval(storageVerificationInterval);
      storageVerificationInterval = null;
    }
  });
}

// Start verification when document is ready
document.addEventListener('DOMContentLoaded', startStorageVerification);
setInterval(verifyStorage, 30000);
// Function that will run after watch history is loaded
// Function to check if a video is live using the PeerTube API
async function checkIfVideoIsLive(videoUrl) {
    try {
        const videoIdMatch = videoUrl.match(/(?:\/videos\/watch\/|\/w\/|\/v\/)([a-zA-Z0-9\-_]+)/);
        if (!videoIdMatch) {
            console.warn("âŒ Could not extract video ID from URL:", videoUrl);
            return false;
        }

        const videoId = videoIdMatch[1];
        const apiUrl = `${window.location.origin}/api/v1/videos/${videoId}`;
        
        const response = await fetch(apiUrl);
        if (!response.ok) {
            console.error(`âŒ Failed to fetch video info: ${response.status} ${response.statusText}`);
            return false;
        }
        
        const videoInfo = await response.json();
        
        // Check if the video is a live stream based on the API response
        const isLive = videoInfo.isLive || videoInfo.state?.id === 12 || videoInfo.state?.label === 'Published (Live)';
        console.log(`ðŸ” API check for ${videoId}: isLive = ${isLive}`, videoInfo);
        
        return isLive;
    } catch (error) {
        console.error("âŒ Error checking if video is live:", error);
        return false;
    }
}

// Modified main function that uses the API to check if a video is live
function main() {
    // Check if we're on a video page
    const isVideoPage = window.location.href.includes("/w/") || window.location.href.includes("/videos/watch/") || window.location.href.includes("/v/");
    if (isVideoPage) {
        // First use the API to check if it's a live stream
        checkIfVideoIsLive(window.location.href).then(isLiveFromAPI => {
		  if (data) {
			const wasLive = data.isLive;
			data.isLive = isLiveFromAPI;

			if (data.isLive && !wasLive) {
			  data.watchedLiveSeconds = 0;
			  console.log("📺 New live stream detected via API. Reset watch counter.");
			}

			console.log("📹 Video API check complete, isLive:", data.isLive);
		  } else {
			console.error("Data is null in main function!");
		  }

		  setupTracking();
		}).catch(error => {
		  console.error("Error in live check:", error);
		  // If API fails, assume not live and continue
		  if (data) data.isLive = false;
		  setupTracking();
		});
    }
}

// Function to fall back to DOM-based detection

// Setup the tracking intervals based on whether it's a live stream or not
// Add this new variable to track when video started playing
let videoPlayStartTime = null;

// Modify setupTracking function to include the 100ms check
function setupTracking() {
    // Add verification at start
    verifyStorage();
    
    // Interval for saving watch data - use a shorter interval for live streams
    setInterval(() => {
        const video = document.querySelector("video");
        if (video && video.readyState >= 3) {
            // Check if it's a live stream from the data object
            const isCurrentlyLive = data && data.isLive;
            
            // For regular videos, update session
            if (!isCurrentlyLive) {
                updateSession(video);
            }
            
            // Save data for both regular and live videos
            saveWatchData();
        }
    }, data && data.isLive ? 5000 : adjustInterval(interval)); // Update every 5 seconds for live streams

    // Final save on unload
    window.addEventListener('beforeunload', function() {
        saveWatchData(true);
    });
    
    // Initialize video play timer and sessionStart tracking
    const video = document.querySelector("video");
    if (video && video.readyState >= 3) {
        // Add play event listener to track when video starts playing
        video.addEventListener('play', function() {
            videoPlayStartTime = Date.now();
            
            // Check after 100ms if video is still playing
            setTimeout(() => {
                if (!video.paused && videoPlayStartTime !== null) {
                    // Video has been playing for at least 100ms
                    if (data.sessionStart === null || data.sessionStart === undefined) {
                        data.sessionStart = video.currentTime;
                        console.log("⚡ Updated sessionStart after 100ms of play:", video.currentTime);
                        
                        // Force a storage save when sessionStart is initially set
                        const existingIndex = prev.findIndex(item => item.url === data.url);
                        if (existingIndex !== -1) {
                            prev[existingIndex] = data;
                        } else {
                            prev.push(data);
                        }
                        chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
                            console.log("📦 Saved sessionStart update to storage");
                        });
                    }
                    
                    // Initialize session if not already done
                    if (currentSession === null) {
                        currentSession = {
                            start: video.currentTime,
                            lastRecordedTime: video.currentTime
                        };
                        console.log("⚡ Initialized session tracking after 100ms of play:", video.currentTime);
                    }
                }
            }, 100);
        });
        
        // Reset play timer on pause
        video.addEventListener('pause', function() {
            videoPlayStartTime = null;
        });
        
        // If video is already playing when we set up tracking, start the timer now
        if (!video.paused) {
            videoPlayStartTime = Date.now();
            
            // Check after 100ms if video is still playing
            setTimeout(() => {
                if (!video.paused && videoPlayStartTime !== null) {
                    // Video has been playing for at least 100ms
                    if (data.sessionStart === null || data.sessionStart === undefined) {
                        data.sessionStart = video.currentTime;
                        console.log("⚡ Updated sessionStart after 100ms of play (already playing):", video.currentTime);
                        
                        // Force a storage save when sessionStart is initially set
                        const existingIndex = prev.findIndex(item => item.url === data.url);
                        if (existingIndex !== -1) {
                            prev[existingIndex] = data;
                        } else {
                            prev.push(data);
                        }
                        chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
                            console.log("📦 Saved sessionStart update to storage");
                        });
                    }
                    
                    // Initialize session if not already done
                    if (currentSession === null) {
                        currentSession = {
                            start: video.currentTime,
                            lastRecordedTime: video.currentTime
                        };
                        console.log("⚡ Initialized session tracking after 100ms of play (already playing):", video.currentTime);
                    }
                }
            }, 100);
        }
    } else if (video) {
        // If video exists but doesn't have enough data, wait for it to be ready
        const checkVideoReadyState = () => {
            if (video.readyState >= 3) {
                // Set up play event listener once video has enough data
                video.addEventListener('play', function() {
                    videoPlayStartTime = Date.now();
                    
                    // Check after 100ms if video is still playing
                    setTimeout(() => {
                        if (!video.paused && videoPlayStartTime !== null) {
                            // Video has been playing for at least 100ms
                            if (data.sessionStart === null || data.sessionStart === undefined) {
                                data.sessionStart = video.currentTime;
                                console.log("⚡ Updated sessionStart after 100ms of play:", video.currentTime);
                                
                                // Force a storage save when sessionStart is initially set
                                const existingIndex = prev.findIndex(item => item.url === data.url);
                                if (existingIndex !== -1) {
                                    prev[existingIndex] = data;
                                } else {
                                    prev.push(data);
                                }
                                chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
                                    console.log("📦 Saved sessionStart update to storage");
                                });
                            }
                            
                            // Initialize session if not already done
                            if (currentSession === null) {
                                currentSession = {
                                    start: video.currentTime,
                                    lastRecordedTime: video.currentTime
                                };
                                console.log("⚡ Initialized session tracking after 100ms of play:", video.currentTime);
                            }
                        }
                    }, 100);
                });
                
                // Reset play timer on pause
                video.addEventListener('pause', function() {
                    videoPlayStartTime = null;
                });
                
                // If video is already playing, start the timer
                if (!video.paused) {
                    videoPlayStartTime = Date.now();
                    
                    // Check after 100ms if video is still playing
                    setTimeout(() => {
                        if (!video.paused && videoPlayStartTime !== null) {
                            // Video has been playing for at least 100ms
                            if (data.sessionStart === null || data.sessionStart === undefined) {
                                data.sessionStart = video.currentTime;
                                console.log("⚡ Updated sessionStart after 100ms of play (after ready):", video.currentTime);
                                
                                // Force a storage save when sessionStart is initially set
                                const existingIndex = prev.findIndex(item => item.url === data.url);
                                if (existingIndex !== -1) {
                                    prev[existingIndex] = data;
                                } else {
                                    prev.push(data);
                                }
                                chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
                                    console.log("📦 Saved sessionStart update to storage");
                                });
                            }
                            
                            // Initialize session if not already done
                            if (currentSession === null) {
                                currentSession = {
                                    start: video.currentTime,
                                    lastRecordedTime: video.currentTime
                                };
                                console.log("⚡ Initialized session tracking after 100ms of play (after ready):", video.currentTime);
                            }
                        }
                    }, 100);
                }
                
                // Stop checking once we've initialized
                clearInterval(readyStateCheck);
            }
        };
        
        // Check every 500ms until video has sufficient data
        const readyStateCheck = setInterval(checkVideoReadyState, 500);
        
        // Add event listener for canplay as a backup
        video.addEventListener('canplay', () => {
            if (video.readyState >= 3) {
                // Set up play event listener once video can play
                video.addEventListener('play', function() {
                    videoPlayStartTime = Date.now();
                    
                    // Check after 100ms if video is still playing
                    setTimeout(() => {
                        if (!video.paused && videoPlayStartTime !== null) {
                            // Video has been playing for at least 100ms
                            if (data.sessionStart === null || data.sessionStart === undefined) {
                                data.sessionStart = video.currentTime;
                                console.log("⚡ Updated sessionStart after 100ms of play (canplay):", video.currentTime);
                                
                                // Force a storage save when sessionStart is initially set
                                const existingIndex = prev.findIndex(item => item.url === data.url);
                                if (existingIndex !== -1) {
                                    prev[existingIndex] = data;
                                } else {
                                    prev.push(data);
                                }
                                chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
                                    console.log("📦 Saved sessionStart update to storage");
                                });
                            }
                            
                            // Initialize session if not already done
                            if (currentSession === null) {
                                currentSession = {
                                    start: video.currentTime,
                                    lastRecordedTime: video.currentTime
                                };
                                console.log("⚡ Initialized session tracking after 100ms of play (canplay):", video.currentTime);
                            }
                        }
                    }, 100);
                });
                
                // Reset play timer on pause
                video.addEventListener('pause', function() {
                    videoPlayStartTime = null;
                });
                
                // If video is already playing, start the timer
                if (!video.paused) {
                    videoPlayStartTime = Date.now();
                    
                    // Check after 100ms if video is still playing
                    setTimeout(() => {
                        if (!video.paused && videoPlayStartTime !== null) {
                            // Video has been playing for at least 100ms
                            if (data.sessionStart === null || data.sessionStart === undefined) {
                                data.sessionStart = video.currentTime;
                                console.log("⚡ Updated sessionStart after 100ms of play (canplay+already playing):", video.currentTime);
                                
                                // Force a storage save when sessionStart is initially set
                                const existingIndex = prev.findIndex(item => item.url === data.url);
                                if (existingIndex !== -1) {
                                    prev[existingIndex] = data;
                                } else {
                                    prev.push(data);
                                }
                                chrome.storage.local.set({ peertubeWatchHistory: JSON.stringify(prev) }, () => {
                                    console.log("📦 Saved sessionStart update to storage");
                                });
                            }
                            
                            // Initialize session if not already done
                            if (currentSession === null) {
                                currentSession = {
                                    start: video.currentTime,
                                    lastRecordedTime: video.currentTime
                                };
                                console.log("⚡ Initialized session tracking after 100ms of play (canplay+already playing):", video.currentTime);
                            }
                        }
                    }, 100);
                }
                
                // Stop checking
                clearInterval(readyStateCheck);
            }
        }, { once: true });
    }
}
// Add a global variable to track when URL last changed
let lastURLChangeTime = Date.now();

// Update URL change detection to set lastURLChangeTime
setInterval(() => {
    if (window.location.href !== lastURL) {
        console.log("URL changed from", lastURL, "to", window.location.href);
        lastURL = window.location.href;
        currentURL = window.location.href; // Update currentURL
        lastURLChangeTime = Date.now(); // Track when URL changed

        // Re-initialize data for the new URL
        data = initializeData();
        
        // Add the new data to the prev array if it doesn't exist
        const existingIndex = prev.findIndex(item => item.url === currentURL);
        if (existingIndex === -1) {
            prev.push(data);
        }
        
        loadWatchHistory(() => {
            console.log("Watch history loaded/reloaded after URL change.");
        });
    }
}, 1000);

// Call main function
main();

// Function to load and merge data from file
function loadAndMergeData(callback) {
    chrome.storage.local.get(['peertubeWatchHistory'], (result) => {
        // Ensure watchHistory is an array
        let watchHistory = Array.isArray(result.peertubeWatchHistory) 
            ? result.peertubeWatchHistory 
            : [];
        
        // Get current video info
        const currentVideoUUID = getVideoUUID();
        const currentVideoUrl = window.location.href;
        
        if (!currentVideoUUID) {
            console.warn('Could not extract video UUID from URL');
            return;
        }

        // Find or create entry for current video
        let entry = watchHistory.find(e => e.uuid === currentVideoUUID);
        if (!entry) {
            entry = {
                uuid: currentVideoUUID,
                url: currentVideoUrl,
                overlap_watchtime: 0,
                liked: false,
                disliked: false,
                timestamp: Date.now()
            };
            watchHistory.push(entry);
        }

        // Save merged data back to storage
        chrome.storage.local.set({ 
            peertubeWatchHistory: watchHistory 
        }, () => {
            if (callback) callback(entry);
        });
    });
}

// Helper function to get video UUID from URL
function getVideoUUID() {
    const match = window.location.pathname.match(/(?:\/videos\/watch\/|\/w\/|\/v\/)([a-zA-Z0-9\-_]+)/);
    return match ? match[1] : null;
}

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', () => {
    console.log("Content script loaded, initializing...");
    loadAndMergeData((entry) => {
        console.log("Watch history entry:", entry);
        currentSession = entry;
        initializeWatchTimeTracking();
    });
});

function initializeWatchTimeTracking() {
    if (!currentSession) {
        console.warn("No current session to track");
        return;
    }

    console.log("Initializing watch time tracking");
    let watchStart = Date.now();
    let lastUpdate = Date.now();
    let watchTimer = setInterval(() => {
        const video = document.querySelector('video');
        if (video && !video.paused) {
            const now = Date.now();
            const elapsed = (now - lastUpdate) / 1000; // Convert to seconds
            currentSession.overlap_watchtime += elapsed;
            
            // Save to storage
            chrome.storage.local.get(['peertubeWatchHistory'], (result) => {
                let history = Array.isArray(result.peertubeWatchHistory) 
                    ? result.peertubeWatchHistory 
                    : [];
                const index = history.findIndex(e => e.uuid === currentSession.uuid);
                if (index !== -1) {
                    history[index] = currentSession;
                }
                chrome.storage.local.set({ 
                    peertubeWatchHistory: history 
                }, () => {
                    console.log("Watch time updated:", currentSession.overlap_watchtime);
                });
            });

            lastUpdate = now;
        }
    }, 5000); // Update every 5 seconds

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        clearInterval(watchTimer);
        // Final save
        chrome.storage.local.get(['peertubeWatchHistory'], (result) => {
            let history = Array.isArray(result.peertubeWatchHistory) 
                ? result.peertubeWatchHistory 
                : [];
            const index = history.findIndex(e => e.uuid === currentSession.uuid);
            if (index !== -1) {
                history[index] = currentSession;
            }
            chrome.storage.local.set({ 
                peertubeWatchHistory: history 
            }, () => {
                console.log("Final watch time saved:", currentSession.overlap_watchtime);
            });
        });
    });

    // Track likes/dislikes
    document.addEventListener('click', (e) => {
        if (e.target.closest('.action-button-like')) {
            currentSession.liked = true;
            currentSession.disliked = false;
            saveCurrentSession();
            console.log("Video liked");
        } else if (e.target.closest('.action-button-dislike')) {
            currentSession.liked = false;
            currentSession.disliked = true;
            saveCurrentSession();
            console.log("Video disliked");
        }
    });
}

function isPeerTubePage() {
  const meta = document.querySelector('meta[property="og:platform"]');
  return meta && meta.content === "PeerTube";
}

function insertImageButton() {
  const searchBox = document.querySelector('my-search-typeahead');
  if (!searchBox || document.querySelector('#my-custom-image-button')) return;

  const img = document.createElement('img');
  img.id = 'my-custom-image-button';
  img.src = chrome.runtime.getURL('icons/icon128.png'); // Path to your PNG
  img.alt = 'Cosine Similarity';
  img.title = 'Open Cosine Similarity';
  img.style.width = '32px';
  img.style.height = '32px';
  img.style.marginLeft = '10px';
  img.style.cursor = 'pointer';
  img.style.verticalAlign = 'middle';

  img.addEventListener('click', () => {
    const url = chrome.runtime.getURL("cosine_similarity.html");
    window.open(url, '_blank');
  });

  searchBox.parentNode.insertBefore(img, searchBox.nextSibling);
}

if (isPeerTubePage()) {
  const observer = new MutationObserver(() => {
    const searchBox = document.querySelector('my-search-typeahead');
    if (searchBox) {
      insertImageButton();
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  insertImageButton();
}


function saveCurrentSession() {
    if (!currentSession) return;
    chrome.storage.local.get(['peertubeWatchHistory'], (result) => {
        let history = Array.isArray(result.peertubeWatchHistory) 
            ? result.peertubeWatchHistory 
            : [];
        const index = history.findIndex(e => e.uuid === currentSession.uuid);
        if (index !== -1) {
            history[index] = currentSession;
        }
        chrome.storage.local.set({ 
            peertubeWatchHistory: history 
        }, () => {
            console.log("Session saved:", currentSession);
        });
    });
}
