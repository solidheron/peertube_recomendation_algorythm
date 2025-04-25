function renderTable(data, preferredInstance, seenUUIDs) {
  const tbody = document.querySelector('#results tbody');
  tbody.innerHTML = '';

  // 🔁 Sort by adjusted similarity before rendering
  const sortedData = [...data].map(entry => {
    const alreadySeen = seenUUIDs.has(entry.shortUUID);
    const adjustedSimilarity = alreadySeen ? entry.similarity * 0.5 : entry.similarity;
    return {
      ...entry,
      adjustedSimilarity,
      alreadySeen
    };
  }).sort((a, b) => b.adjustedSimilarity - a.adjustedSimilarity); // descending

  sortedData.forEach(entry => {
    const originalLink = entry.mod_url
      ? `<a href="${entry.mod_url}" target="_blank">${entry.mod_url}</a>`
      : `<a href="${entry.url}" target="_blank">${entry.url}</a>`;

    const altLink = preferredInstance
      ? `<a href="${preferredInstance}/w/${entry.shortUUID}" target="_blank">${preferredInstance}/w/${entry.shortUUID}</a>`
      : '(not set)';

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${entry.adjustedSimilarity.toFixed(3)}</td>
      <td>${originalLink}</td>
      <td>${altLink}</td>
    `;

    if (entry.alreadySeen) {
      row.style.opacity = "0.6";
    }

    tbody.appendChild(row);
  });
}


function extractUUIDFromURL(url) {
  try {
    const parts = url.split('/');
    return parts[parts.length - 1];
  } catch (e) {
    return null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('instanceInput');
  const saveBtn = document.getElementById('saveInstance');

  chrome.storage.local.get(['cosine_similarity', 'preferredInstance', 'peertubeWatchHistory'], (result) => {
    const similarityData = result.cosine_similarity || [];
    const preferredInstance = result.preferredInstance || '';
    const watchHistory = result.peertubeWatchHistory ? JSON.parse(result.peertubeWatchHistory) : [];

    // ✅ Extract shortUUIDs from watched URLs
    const seenUUIDs = new Set(
      watchHistory
        .map(entry => extractUUIDFromURL(entry.url))
        .filter(uuid => uuid) // remove nulls
    );

    input.value = preferredInstance;
    renderTable(similarityData, preferredInstance, seenUUIDs);
  });

  saveBtn.addEventListener('click', () => {
    const instance = input.value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\/]+/.test(instance)) {
      alert("Please enter a valid instance URL like: https://peertube.example.com");
      return;
    }

    chrome.storage.local.set({ preferredInstance: instance }, () => {
      chrome.storage.local.get(['cosine_similarity', 'peertubeWatchHistory'], (result) => {
        const data = result.cosine_similarity || [];
        const watchHistory = result.peertubeWatchHistory ? JSON.parse(result.peertubeWatchHistory) : [];
        const seenUUIDs = new Set(
          watchHistory
            .map(entry => extractUUIDFromURL(entry.url))
            .filter(uuid => uuid)
        );
        renderTable(data, instance, seenUUIDs);
        alert("✅ Preferred instance updated!");
      });
    });
  });
});

