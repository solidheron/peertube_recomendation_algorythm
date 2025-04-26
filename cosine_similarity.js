// Utility functions
function getDomainFromUrl(url) {
  try {
    const domain = new URL(url).hostname;
    return domain;
  } catch (e) {
    return url;
  }
}

function constructVideoUrl(baseUrl, shortUUID) {
  try {
    const urlParts = new URL(baseUrl);
    return `${urlParts.protocol}//${urlParts.hostname}/w/${shortUUID}`;
  } catch (e) {
    console.error('Error constructing video URL:', e);
    return baseUrl;
  }
}

function extractUUIDFromURL(url) {
  if (!url) return null;

  // Match pattern /w/UUID format
  const watchMatch = url.match(/\/w\/([a-zA-Z0-9_-]+)/);
  if (watchMatch && watchMatch[1]) return watchMatch[1];

  // Alternative formats if needed
  const videoMatch = url.match(/\/videos\/watch\/([a-zA-Z0-9_-]+)/);
  if (videoMatch && videoMatch[1]) return videoMatch[1];

  return null;
}

// Sorting state
let currentSortColumn = 'time'; // Default sort by time similarity
let currentSortDirection = 'desc'; // Default sort direction

// Function to fetch metadata from IndexedDB
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
    console.error(`Error fetching metadata for ${shortUUID}:`, error);
    return null;
  }
}

function renderTable(data, preferredInstances, seenUUIDs) {
  const tbody = document.querySelector('#results tbody');
  tbody.innerHTML = '';

  // Process data with seen status and adjusted similarity scores
  const processedData = [...data].map(entry => {
    const alreadySeen = seenUUIDs.has(entry.shortUUID);
    // Apply 0.5 multiplier to both similarity scores if video has been seen
    const adjustedTimeSimilarity = alreadySeen ? 
      entry.tokens.time_engagement_similarity * 0.5 : 
      entry.tokens.time_engagement_similarity;
    const adjustedLikeSimilarity = alreadySeen ? 
      entry.tokens.like_engagement_similarity * 0.5 : 
      entry.tokens.like_engagement_similarity;

    return {
      ...entry,
      adjustedTimeSimilarity,
      adjustedLikeSimilarity,
      alreadySeen
    };
  });

  // Sort data based on current sort column and direction
  const sortedData = processedData.sort((a, b) => {
    let valueA, valueB;

    if (currentSortColumn === 'time') {
      valueA = a.adjustedTimeSimilarity;
      valueB = b.adjustedTimeSimilarity;
    } else if (currentSortColumn === 'like') {
      valueA = a.adjustedLikeSimilarity;
      valueB = b.adjustedLikeSimilarity;
    }

    // Apply sort direction
    return currentSortDirection === 'desc' ? valueB - valueA : valueA - valueB;
  });

  // Limit to 500 rows
  const limitedData = sortedData.slice(0, 500);

  // Create and append rows
  limitedData.forEach(async (entry) => {
    // Construct the original URL with shortUUID
    const originalUrl = constructVideoUrl(entry.url, entry.shortUUID);

    // Create row element
    const row = document.createElement('tr');
    if (entry.alreadySeen) {
      row.classList.add('seen');
    }

    // Add time and like similarity cells
    row.innerHTML = `
      <td>${entry.adjustedTimeSimilarity.toFixed(3)}</td>
      <td>${entry.adjustedLikeSimilarity.toFixed(3)}</td>
      <td class="video-cell" data-uuid="${entry.shortUUID}">
        <div class="video-info">
          <a href="${originalUrl}" target="_blank" class="video-url">${originalUrl}</a>
          <div class="video-metadata">
            <div class="account-info">Account: ${entry.account?.displayName || 'Unknown'}</div>
            ${entry.channel?.displayName ? `<div class="channel-info">Channel: ${entry.channel.displayName}</div>` : ''}
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

    // Try to get additional metadata from IndexedDB
    try {
      const metadata = await getMetadataFromDB(entry.shortUUID);
      if (metadata) {
        const videoCell = row.querySelector('.video-cell');
        if (videoCell) {
          const metadataDiv = videoCell.querySelector('.video-metadata');
          if (metadataDiv) {
            metadataDiv.innerHTML = `
              <div class="account-info">Account: ${metadata.account?.displayName || 'Unknown'}</div>
              ${metadata.channel?.displayName ? `<div class="channel-info">Channel: ${metadata.channel.displayName}</div>` : ''}
            `;
          }
        }
      }
    } catch (error) {
      console.warn(`Could not fetch additional metadata for ${entry.shortUUID}:`, error);
    }
  });

  // Update header classes to show sort direction
  document.querySelectorAll('th[data-sort]').forEach(header => {
    header.classList.remove('sort-asc', 'sort-desc');
    if (header.dataset.sort === currentSortColumn) {
      header.classList.add(currentSortDirection === 'desc' ? 'sort-desc' : 'sort-asc');
    }
  });
}

function setupSortingListeners() {
  document.querySelectorAll('th[data-sort]').forEach(header => {
    header.addEventListener('click', () => {
      const sortType = header.dataset.sort;
      if (sortType === currentSortColumn) {
        // Toggle direction if clicking the same column
        currentSortDirection = currentSortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        // New column, set to descending by default
        currentSortColumn = sortType;
        currentSortDirection = 'desc';
      }

      // Re-render with current data
      chrome.storage.local.get([
        'cosine_similarity', 
        'preferredInstances', 
        'peertubeWatchHistory',
        'seenUUIDs'
      ], (result) => {
        const similarityData = result.cosine_similarity || [];
        const preferredInstances = result.preferredInstances || [];
        const watchHistory = result.peertubeWatchHistory ? JSON.parse(result.peertubeWatchHistory) : [];
        const storedSeenUUIDs = result.seenUUIDs || [];

        const seenUUIDs = new Set([
          ...storedSeenUUIDs,
          ...watchHistory
            .map(entry => extractUUIDFromURL(entry.url))
            .filter(uuid => uuid)
        ]);

        renderTable(similarityData, preferredInstances, seenUUIDs);
      });
    });
  });
}

function renderInstancesList(instances) {
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
}

// Instance management functions
function removeInstance(instance) {
  chrome.storage.local.get(['preferredInstances'], (result) => {
    const instances = result.preferredInstances || [];
    const updatedInstances = instances.filter(i => i !== instance);

    chrome.storage.local.set({ preferredInstances: updatedInstances }, () => {
      chrome.storage.local.get(['cosine_similarity', 'peertubeWatchHistory', 'seenUUIDs'], (result) => {
        const data = result.cosine_similarity || [];
        const watchHistory = result.peertubeWatchHistory ? JSON.parse(result.peertubeWatchHistory) : [];
        const storedSeenUUIDs = result.seenUUIDs || [];

        // Combine UUIDs from both sources
        const seenUUIDs = new Set([
          ...storedSeenUUIDs,
          ...watchHistory
            .map(entry => extractUUIDFromURL(entry.url))
            .filter(uuid => uuid)
        ]);

        renderInstancesList(updatedInstances);
        renderTable(data, updatedInstances, seenUUIDs);
      });
    });
  });
}

// Initialize everything when the document is loaded
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('instanceInput');
  const saveBtn = document.getElementById('saveInstance');

  // Set up sorting listeners
  setupSortingListeners();

  // Initial load of data and rendering
  chrome.storage.local.get([
    'cosine_similarity', 
    'preferredInstances', 
    'peertubeWatchHistory',
    'seenUUIDs'
  ], (result) => {
    const similarityData = result.cosine_similarity || [];
    const preferredInstances = result.preferredInstances || [];
    const watchHistory = result.peertubeWatchHistory ? JSON.parse(result.peertubeWatchHistory) : [];
    const storedSeenUUIDs = result.seenUUIDs || [];

    // Combine UUIDs from both watch history and stored seen UUIDs
    const seenUUIDs = new Set([
      ...storedSeenUUIDs,
      ...watchHistory
        .map(entry => extractUUIDFromURL(entry.url))
        .filter(uuid => uuid)
    ]);

    renderInstancesList(preferredInstances);
    renderTable(similarityData, preferredInstances, seenUUIDs);
  });

  // Handle adding new instances
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
        chrome.storage.local.get(['cosine_similarity', 'peertubeWatchHistory', 'seenUUIDs'], (result) => {
          const data = result.cosine_similarity || [];
          const watchHistory = result.peertubeWatchHistory ? JSON.parse(result.peertubeWatchHistory) : [];
          const storedSeenUUIDs = result.seenUUIDs || [];

          const seenUUIDs = new Set([
            ...storedSeenUUIDs,
            ...watchHistory
              .map(entry => extractUUIDFromURL(entry.url))
              .filter(uuid => uuid)
          ]);

          input.value = '';
          renderInstancesList(updatedInstances);
          renderTable(data, updatedInstances, seenUUIDs);
          alert("✅ Instance added successfully!");
        });
      });
    });
  });
});