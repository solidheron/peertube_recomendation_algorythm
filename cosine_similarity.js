let filterMode = 'all';
let currentSortColumn = 'time'; // Default sort by time similarity
let currentSortDirection = 'desc'; // Default sort direction
function getDomainFromUrl(url) {
  try {
    const domain = new URL(url).hostname;
    return domain;
  } catch (e) {
    return url;
  }
}

function applyNsfwFilter(mode, data) {
  switch(mode) {
    case 'all': 
      return data; // No filtering
    case 'sfw': 
      return data.filter(item => !item.nsfw); // Hide NSFW content
    case 'only': 
      return data.filter(item => item.nsfw); // Show only NSFW content
    default:
      return data;
  }
}

function insertLineBreaks(title, maxChars = 60) {
  let lines = [];
  let currentLine = '';
  
  // Split title into words
  const words = title.split(' ');
  
  for (const word of words) {
    // Check if adding the next word exceeds the max length
    if (currentLine.length + word.length + 1 > maxChars) {
      // If current line is empty (word is too long), add it anyway
      if (currentLine === '') {
        lines.push(word);
      } else {
        lines.push(currentLine.trim());
      }
      currentLine = word;
    } else {
      currentLine += ` ${word}`;
    }
  }
  
  // Add the last line
  lines.push(currentLine.trim());
  
  return lines.join('<br>');
}

function constructVideoUrl(baseUrl, shortUUID) {
  try {
    const urlParts = new URL(baseUrl);
    return `${urlParts.protocol}//${urlParts.hostname}/w/${shortUUID}`;
  } catch (e) {
    //console.error('Error constructing video URL:', e);
    return baseUrl;
  }
}

async function checkUrlValidity(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok && response.status !== 404;
  } catch (error) {
    console.error(`Error checking URL ${url}:`, error);
    return false;
  }
}

function extractUUIDFromURL(url) {
	chrome.storage.local.set({ url:url })
  if (!url || typeof url !== 'string') return null;

  url = url.trim();

  const patterns = [
    /\/w\/([a-zA-Z0-9_-]+)/,
    /\/videos\/watch\/([a-zA-Z0-9_-]+)/,
    /\/videos\/embed\/([a-zA-Z0-9_-]+)/ // optional: for embedded videos
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }

  return null;
}

async function getMetadataFromDB(shortUUID) {
  try {
    // Initialize the database connection
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('peertubeDB', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    // Get the metadata from the store
    const tx = db.transaction('metadataList', 'readonly');
    const store = tx.objectStore('metadataList');

    return new Promise((resolve, reject) => {
      const request = store.get(shortUUID);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    //console.error(`Error fetching metadata for ${shortUUID}:`, error);
    return null;
  }
}

async function renderTable(data) {
  console.log("renderTable called with data:", data);
  
  // CRITICAL FIX: Looking at the original code, filteredData is created differently
  // In the original code, it filters the data and then pushes entries with a channel limit
  // Let's make sure we're handling this correctly
  
  // 1. Get all necessary data from storage at once
  const { peertubeWatchHistory, seenUUIDs, preferredInstances } = await new Promise(resolve => {
    chrome.storage.local.get(['peertubeWatchHistory', 'seenUUIDs', 'preferredInstances'], result => {
      resolve({
        peertubeWatchHistory: result.peertubeWatchHistory ? JSON.parse(result.peertubeWatchHistory) : [],
        seenUUIDs: result.seenUUIDs || [],
        preferredInstances: result.preferredInstances || []
      });
    });
  });

  // 2. Extract UUIDs from watch history URLs
  const uuidsFromHistory = peertubeWatchHistory
    .map(entry => extractUUIDFromURL(entry.url))
    .filter(Boolean);

  // 3. Combine all sources into a Set for fast lookup
  const seenUUIDsSet = new Set([...seenUUIDs, ...uuidsFromHistory]);

  // CRITICAL FIX: We need to fetch metadata like the original code did
  // Instead of from storage, we should use the IndexedDB like in the original
  let metadataList = [];
  try {
    // This is how the original code got metadata
    metadataList = await db.getMetadataList();
  } catch (error) {
    console.error("Error fetching metadata from DB:", error);
    // Continue with empty metadata if there's an error
  }

  // 4. Create a map of shortUUID to metadata for fast lookup
  const metadataMap = new Map();
  if (Array.isArray(metadataList)) {
    metadataList.forEach(metadata => {
      if (metadata && metadata.shortUUID) {
        metadataMap.set(metadata.shortUUID, metadata);
      }
    });
  }

  // 5. Process data with all available information
  const processedData = [...data].map(entry => {
    if (!entry || !entry.shortUUID) return null;
    
    const alreadySeen = seenUUIDsSet.has(entry.shortUUID);
    
    // Only access tokens if they exist
    let timeEngagementSimilarity = 0;
    let likeEngagementSimilarity = 0;
    
    if (entry.tokens) {
      timeEngagementSimilarity = entry.tokens.time_engagement_similarity || 0;
      likeEngagementSimilarity = entry.tokens.like_engagement_similarity || 0;
    }
    
    const adjustedTimeSimilarity = alreadySeen ? timeEngagementSimilarity * 0.2 : timeEngagementSimilarity;
    const adjustedLikeSimilarity = alreadySeen ? likeEngagementSimilarity * 0.2 : likeEngagementSimilarity;
    
    // Get metadata from our map
    const metadata = metadataMap.get(entry.shortUUID) || {};
    
    return { 
      ...entry,
      adjustedTimeSimilarity, 
      adjustedLikeSimilarity, 
      alreadySeen,
      title: metadata.name || entry.title || 'Untitled Video',
      nsfw: metadata.nsfw || entry.nsfw || false,
      account: metadata.account || entry.account || { displayName: 'Unknown' },
      channel: metadata.channel || entry.channel || { displayName: '' }
    };
  }).filter(Boolean); // Remove any null entries

  // 6. Sort the data according to current sort settings
  // Use the global sorting variables here
  const sortedData = processedData.sort((a, b) => {
    let valueA, valueB;

    if (currentSortColumn === 'time') {
      valueA = a.adjustedTimeSimilarity;
      valueB = b.adjustedTimeSimilarity;
    } else if (currentSortColumn === 'like') {
      valueA = a.adjustedLikeSimilarity;
      valueB = b.adjustedLikeSimilarity;
    }

    return currentSortDirection === 'desc' ? valueB - valueA : valueA - valueB;
  });
  const channelCount = new Map();
  const filteredData = [];
  
  // First - filter for valid UUIDs with tokens
  const validEntries = sortedData.filter(entry => 
    entry.shortUUID && 
    entry.shortUUID.length === 21 && 
    entry.tokens // Make sure tokens exist
  );
  
  // Then - apply channel limiting
  for (const entry of sortedData) {
    const channelName = entry.channel?.displayName || entry.shortUUID;
    const currentCount = channelCount.get(channelName) || 0;
    if (currentCount < 2) {
      filteredData.push(entry);
      channelCount.set(channelName, currentCount + 1);
    }
  }

  // 8. Apply NSFW filter and limit results
  // Make sure filterMode is defined - get it from storage if needed
  if (typeof filterMode === 'undefined') {
    const filterModeResult = await new Promise(resolve => {
      chrome.storage.local.get(['filterMode'], result => {
        resolve(result.filterMode || 'all');
      });
    });
    filterMode = filterModeResult;
  }
  
  const filteredDataAfterNsfw = applyNsfwFilter(filterMode, filteredData);
  const limitedData = filteredDataAfterNsfw.slice(0, 1000);

  // 9. Render table content
  const tbody = document.querySelector('#results tbody');
  tbody.innerHTML = '';

  for (const entry of limitedData) {
    try {
      const originalUrl = constructVideoUrl(entry.url, entry.shortUUID);
      const row = document.createElement('tr');
      
      if (entry.alreadySeen) {
        row.classList.add('seen');
      }

      // Display metadata that's already fully loaded
      const accountName = entry.account?.displayName || 'Unknown';
      const channelName = entry.channel?.displayName || '';

      row.innerHTML = `
        <td>${entry.adjustedTimeSimilarity.toFixed(3)}</td>
        <td>${entry.adjustedLikeSimilarity.toFixed(3)}</td>
        <td class="video-cell" data-uuid="${entry.shortUUID}">
          <div class="video-info">
            <div class="video-title">${insertLineBreaks(entry.title || 'Untitled Video')}</div>
            <a href="${originalUrl}" target="_blank" class="video-url">${originalUrl}</a>
            <div class="video-metadata">
              <div class="account-info">Account: ${accountName}</div>
              ${channelName ? `<div class="channel-info">Channel: ${channelName}</div>` : ''}
            </div>
          </div>
        </td>
        <td>${
          preferredInstances.length > 0
            ? preferredInstances.map(instance => 
                `<a href="${instance}/w/${entry.shortUUID}" 
                    target="_blank" 
                    class="instance-link" 
                    title="${instance}/w/${entry.shortUUID}">
                    ${getDomainFromUrl(instance)}
                </a>`
              ).join('')
            : '(no instances set)'
        }</td>
      `;

      tbody.appendChild(row);
    } catch (error) {
      console.error("Error processing entry:", error, entry);
    }
  }
  
  console.log("Rendered table with", limitedData.length, "rows");

  document.querySelectorAll('th[data-sort]').forEach(header => {
    header.classList.remove('sort-asc', 'sort-desc');
    if (header.dataset.sort === currentSortColumn) {
      header.classList.add(currentSortDirection === 'desc' ? 'sort-desc' : 'sort-asc');
    }
  });
}

function setupSortingListeners() {
  document.querySelectorAll('th[data-sort]').forEach(header => {
    header.addEventListener('click', async () => {
      const sortType = header.dataset.sort;
      if (sortType === currentSortColumn) {
        currentSortDirection = currentSortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        currentSortColumn = sortType;
        currentSortDirection = 'desc';
      }

      chrome.storage.local.get(['cosine_similarity'], async (result) => {
        const similarityData = result.cosine_similarity || [];
        // No need to fetch preferredInstances separately - it's handled in renderTable
        renderTable(similarityData);
      });
    });
  });
}

function renderInstancesList() {
  chrome.storage.local.get(['preferredInstances'], (result) => {
    const instances = result.preferredInstances || [];
    const instancesList = document.getElementById('instancesList');
    instancesList.innerHTML = '';

    instances.forEach(instance => {
      const div = document.createElement('div');
      div.className = 'instance-item';
      div.innerHTML = `
        ${getDomainFromUrl(instance)}
        <span class="remove-instance" data-instance="${instance}">✖</span>
      `;
      instancesList.appendChild(div);
    });

    // Add event listeners for remove buttons
    document.querySelectorAll('.remove-instance').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const instanceToRemove = e.target.dataset.instance;
        removeInstance(instanceToRemove);
      });
    });
  });
}

// Instance management functions
function removeInstance(instance) {
  chrome.storage.local.get(['preferredInstances'], (result) => {
    const instances = result.preferredInstances || [];
    const updatedInstances = instances.filter(i => i !== instance);

    chrome.storage.local.set({ preferredInstances: updatedInstances }, () => {
      chrome.storage.local.get(['cosine_similarity'], (result) => {
        const data = result.cosine_similarity || [];
        
        renderInstancesList(); // This will now fetch from storage directly
        renderTable(data); // No need to pass preferredInstances
      });
    });
  });
}
// Initialize everything when the document is loaded
document.getElementById('nsfw-toggle').addEventListener('change', function() {
  filterMode = this.value;
  chrome.storage.local.set({ filterMode: filterMode });
  
  // Re-fetch data and re-render table with updated filter
  chrome.storage.local.get(['cosine_similarity'], async (result) => {
    const similarityData = result.cosine_similarity || [];
    // No need to pass preferredInstances - it's handled in renderTable
    renderTable(similarityData);
  });
});

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('instanceInput');
  const saveBtn = document.getElementById('saveInstance');
  
  chrome.storage.local.get(['filterMode'], (result) => {
    if (result.filterMode) {
      filterMode = result.filterMode;
      document.getElementById('nsfw-toggle').value = filterMode;
    }
  });

  setupSortingListeners();
  chrome.storage.local.get(['cosine_similarity'], async (result) => {
    const similarityData = result.cosine_similarity || [];

    renderInstancesList(); // Update this function too to get data from storage
    renderTable(similarityData);
  });

  // Update in the instance save button handler
  saveBtn.addEventListener('click', () => {
    const instance = input.value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\/]+/.test(instance)) {
      alert("Please enter a valid instance URL like: https://peertube.example.com");
      return;
    }

    chrome.storage.local.get(['preferredInstances'], (result) => {
      const instances = result.preferredInstances || [];
      if (instances.includes(instance)) {
        alert("This instance is already in your list!");
        return;
      }

      const updatedInstances = [...instances, instance];
      chrome.storage.local.set({ preferredInstances: updatedInstances }, () => {
        chrome.storage.local.get(['cosine_similarity'], (result) => {
          const data = result.cosine_similarity || [];
          
          input.value = '';
          renderInstancesList(); // Update this function to get from storage
          renderTable(data); // No need to pass preferredInstances
          alert("✅ Instance added successfully!");
        });
      });
    });
  });
});
  
  document.addEventListener('click', async (event) => {
  const target = event.target;
  if (target.classList.contains('instance-link')) {
    event.preventDefault();
    const url = target.href;

    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok) {
        window.open(url, '_blank');
      } else {
        alert('The link is not available (404).');
      }
    } catch (error) {
      alert('Error checking the link availability.');
    }
  }
});

document.addEventListener("DOMContentLoaded", function() {
    // Get the button element
    const openOptionsBtn = document.getElementById("openOptionsBtn");

    // Add a click event listener
    openOptionsBtn.addEventListener("click", function() {
        // Open options.html in a new tab
        window.open("options.html", "_blank");
    });
});
