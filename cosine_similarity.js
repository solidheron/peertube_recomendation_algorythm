// Utility functions
let filterMode = 'all'
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

// Helper function to insert line breaks every 60 characters
// Helper function to insert line breaks before spaces near 60-character limit
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
    //console.error(`Error fetching metadata for ${shortUUID}:`, error);
    return null;
  }
}

async function renderTable(data, preferredInstances) {
	
  function getFromStorage(keys) {

    return new Promise(resolve => {

      chrome.storage.local.get(keys, resolve);

    });

  }

  // 1. Get watch history and stored seen UUIDs from chrome.storage.local

  const result = await getFromStorage(['peertubeWatchHistory', 'seenUUIDs']);

  // 2. Parse and combine all seen UUIDs
  const watchHistory = result.peertubeWatchHistory ? JSON.parse(result.peertubeWatchHistory) : [];
  const storedSeenUUIDs = result.seenUUIDs || [];

  // Extract UUIDs from watch history URLs
  const uuidsFromHistory = watchHistory
    .map(entry => extractUUIDFromURL(entry.url))
    .filter(Boolean);

  // Combine all sources into a Set for fast lookup
  const seenUUIDs = new Set([...storedSeenUUIDs, ...uuidsFromHistory]);

  // 3. Proceed with the rest of your table logic
  const tbody = document.querySelector('#results tbody');
  tbody.innerHTML = '';

  const processedData = [...data].map(entry => {
    const alreadySeen = seenUUIDs.has(entry.shortUUID);
    const adjustedTimeSimilarity = alreadySeen ? entry.tokens.time_engagement_similarity * 0.2 : entry.tokens.time_engagement_similarity;
    const adjustedLikeSimilarity = alreadySeen ? entry.tokens.like_engagement_similarity * 0.2 : entry.tokens.like_engagement_similarity;
    return { ...entry, adjustedTimeSimilarity, adjustedLikeSimilarity, alreadySeen };
  });

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
  const filteredData = data.filter(entry => {
  const validUUID = entry.shortUUID && entry.shortUUID.length === 21; // Adjust length as needed
	  return validUUID && entry.tokens; // Ensure tokens exist
	});
  for (const entry of sortedData) {
    const channelName = entry.channel?.displayName || entry.shortUUID;
    const currentCount = channelCount.get(channelName) || 0;
    if (currentCount < 2) {
      filteredData.push(entry);
      channelCount.set(channelName, currentCount + 1);
    }
  }
  const filteredDataAfterNsfw = applyNsfwFilter(filterMode, filteredData)
//chrome.storage.local.set({ filteredData };
//chrome.storage.local.set({ perb: filteredDataAfterNsfw });
  const limitedData = filteredDataAfterNsfw.slice(0, 1000);

  // Use for...of to await async calls properly
  for (const entry of limitedData) {
    const originalUrl = constructVideoUrl(entry.url, entry.shortUUID);

    const row = document.createElement('tr');
    if (entry.alreadySeen) {
      row.classList.add('seen');
    }

    // Render initial metadata from entry (fallback to Unknown)
    const accountName = entry.account?.displayName || 'Unknown';
    const channelName = entry.channel?.displayName || '';

	row.innerHTML = `
	  <td>${entry.adjustedTimeSimilarity.toFixed(3)}</td>
	  <td>${entry.adjustedLikeSimilarity.toFixed(3)}</td>
	  <td class="video-cell" data-uuid="${entry.shortUUID}">
		<div class="video-info">
		  <div class="video-title">${insertLineBreaks(entry.title)}</div>
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

    // Fetch and update metadata asynchronously
    try {
      const metadata = await getMetadataFromDB(entry.shortUUID);
      if (metadata) {
        const videoCell = row.querySelector('.video-cell');
        if (videoCell) {
          const metadataDiv = videoCell.querySelector('.video-metadata');
          if (metadataDiv) {
            // Update metadata with fresh data or fallback
            const updatedAccountName = metadata.account?.displayName || 'Unknown';
            const updatedChannelName = metadata.channel?.displayName || '';

            metadataDiv.innerHTML = `
              <div class="account-info">Account: ${updatedAccountName}</div>
              ${updatedChannelName ? `<div class="channel-info">Channel: ${updatedChannelName}</div>` : ''}
            `;
          }
        }
      } else {
        // If no metadata found, ensure original data is shown (optional)
        // This can be omitted if you want to keep original render
      }
    } catch (error) {
      console.warn(`Could not fetch additional metadata for ${entry.shortUUID}:`, error);
    }
  }

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
    header.addEventListener('click', async () => {
      const sortType = header.dataset.sort;
      if (sortType === currentSortColumn) {
        currentSortDirection = currentSortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        currentSortColumn = sortType;
        currentSortDirection = 'desc';
      }

      chrome.storage.local.get([
        'cosine_similarity', 
        'preferredInstances'
        
      ], async (result) => {
        const similarityData = result.cosine_similarity || [];
        const preferredInstances = result.preferredInstances || [];
        // Fetch metadata list from IndexedDB
        const metadataList = await db.getMetadataList();

        // Augment similarity data with metadata
        const augmentedData = similarityData.map(entry => {
          const matchingMetadata = metadataList.find(meta => meta.shortUUID === entry.shortUUID);
          return {
            ...entry,
			title: matchingMetadata?.name|| 'Untitled Video',
			nsfw: matchingMetadata?.nsfw|| false,
            account: matchingMetadata?.account || { displayName: '' },
            channel: matchingMetadata?.channel || { displayName: '' }
          };
        });

        renderTable(augmentedData, preferredInstances);
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
                
        renderInstancesList(updatedInstances);
        renderTable(data, updatedInstances);
      });
    });
  });
}
// cosine_similarity.js


function updateUI(filteredData) {
  // Your existing UI update logic here
  // Example: render results based on filteredData
}

// Initialize everything when the document is loaded
document.getElementById('nsfw-toggle').addEventListener('change', function() {
  filterMode = this.value;
  chrome.storage.local.set({ filterMode: filterMode });
  
  // Re-fetch data and re-render table with updated filter
  chrome.storage.local.get([
    'cosine_similarity', 
    'preferredInstances'
    
  ], async (result) => {
    const similarityData = result.cosine_similarity || [];
    const preferredInstances = result.preferredInstances || [];
    

    try {
      // Fetch metadata from IndexedDB
      const metadataList = await db.getMetadataList();

      // Augment similarity data with metadata
      const augmentedData = similarityData.map(entry => {
        const matchingMetadata = metadataList.find(meta => meta.shortUUID === entry.shortUUID);
        return {
          ...entry,
          title: matchingMetadata?.name || 'Untitled Video',
          nsfw: matchingMetadata?.nsfw || false,
          account: matchingMetadata?.account || { displayName: '' },
          channel: matchingMetadata?.channel || { displayName: '' }
        };
      });

      // Render table with filtered data
      renderTable(augmentedData, preferredInstances);
    } catch (error) {
      console.error('Error fetching metadata:', error);
      // Fallback if metadata can't be fetched
      renderTable(similarityData, preferredInstances);
    }
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
	
  // Set up sorting listeners
  setupSortingListeners();

  // Initial load of data and rendering
  chrome.storage.local.get([
    'cosine_similarity', 
    'preferredInstances'
  ], async (result) => {
    const similarityData = result.cosine_similarity || [];
    const preferredInstances = result.preferredInstances || [];
      

    // Fetch metadata from IndexedDB
	const metadataList = await db.getMetadataList();

    // Augment similarity data with account/channel info
const augmentedData = similarityData.map(entry => {
  const matchingMetadata = metadataList.find(meta => meta.shortUUID === entry.shortUUID);
  return {
    ...entry,
    title: matchingMetadata?.name|| 'Untitled Video', // Add this line
	nsfw: matchingMetadata?.nsfw|| false,
    account: {
      ...matchingMetadata?.account,
      displayName: matchingMetadata?.account?.displayName || ''
    },
    channel: {
      ...matchingMetadata?.channel,
      displayName: matchingMetadata?.channel?.displayName || ''
    }
  };
});

    // Render the table with augmented data
    renderInstancesList(preferredInstances);
    renderTable(augmentedData, preferredInstances);
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
      chrome.storage.local.set({ preferredInstances: updatedInstances }, async () => {
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
          chrome.storage.local.set({ seenpart2: seenUUIDs });
          // Re-fetch metadata to ensure up-to-date info
          getMetadataList().then(metadataList => {
            const augmentedData = data.map(entry => {
              const meta = metadataList.find(m => m.shortUUID === entry.shortUUID);
              return {
                ...entry,
                account: meta?.account || {},
                channel: meta?.channel || {}
              };
            });
            
            input.value = '';
            renderInstancesList(updatedInstances);
            renderTable(augmentedData, updatedInstances, seenUUIDs);
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

});