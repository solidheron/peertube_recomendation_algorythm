console.log("🚀 PeerTube Tracker content script loaded!");

// Global variables
let currentSession = null;
let ctrlPressed = false;
let shiftPressed = false;
let lastSavedSegment = null;
let lastSaveTime = 0;
const interval = 2;

// Initialize data object
let data = {};

// Variable to store the previous current time
let previousCurrentTime = 0;

// Variable to track if the video is playing
let isVideoPlaying = false;

// Get current URL and history array from localStorage
let currentURL = window.location.href;
let prev = JSON.parse(localStorage.getItem('peertubeWatchHistory') || '[]');

// Function to initialize or reset data
function initializeData() {
  return {
    title: document.title,
    url: currentURL,
    currentTime: 0,
    duration: 0,
    percentWatched: 0,
    liked: false,
    disliked: false,
    last_update: new Date().toISOString(),
    session: {
      segments: []
    },
    sessionStart: null,
    finished: false
  };
}

// Ensure prev is an array
prev = Array.isArray(prev) ? prev : [];

// Use exact URL match if found
const exactMatch = prev.find(item => item?.url === currentURL);

// Reset data if no match or duration has changed
if (!exactMatch || (document.querySelector('video') && document.querySelector('video').duration !== exactMatch.duration)) {
  console.log("🔥 Different video URL or duration detected. Resetting data.");
  if (prev.length > 0 && prev[0]?.url && currentURL.length === prev[0].url.length) {
    console.log("⚠️ URLs have the same length but are different.");
  }
  data = initializeData();
  data.session = { segments: [] };
  currentSession = null;
} else {
  let existingEntry = prev.find(item => item.url === currentURL);
  if (existingEntry) {
    data = existingEntry;
    console.log("✅ Existing data loaded:", data);
  } else {
    data = initializeData();
    console.log("No existing data found for this URL. Initializing new data.");
  }
}

// Helper function to deduplicate segments within a single session
function deduplicateSegments(segments) {
  return segments.filter((seg, index, self) =>
    index === self.findIndex(s =>
      Math.abs(s.start - seg.start) < 0.001 && Math.abs(s.end - seg.end) < 0.001
    )
  );
}

// Helper: Compare two session segments arrays for equality (order matters)
function areSessionSegmentsEqual(segments1, segments2) {
  if (segments1.length !== segments2.length) return false;
  for (let i = 0; i < segments1.length; i++) {
    if (
      Math.abs(segments1[i].start - segments2[i].start) > 0.001 ||
      Math.abs(segments1[i].end - segments2[i].end) > 0.001
    ) {
      return false;
    }
  }
  return true;
}

// updateSession(video)
// Records watch segments and avoids adding duplicates.
function updateSession(video) {
  if (!video) return null;
  const time = video.currentTime;
  const playbackRate = video.playbackRate || 1;

  if (currentSession !== null && time < currentSession.start) {
    currentSession.start = time;
    console.log("⏪ Video jumped back. Updating session start to:", time);
  }

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
              timestamp: new Date().toISOString(),
            });
          } else {
            console.log("Segment already exists, not adding.");
          }
        }
      }
      data.sessionStart = currentSession.start;
      currentSession = null;
    }
    return null;
  } else {
    isVideoPlaying = true;
    let tolerance = (interval+.5) * playbackRate;
    if (currentSession === null) {
      currentSession = {
        start: time,
        lastRecordedTime: time,
        segments: []
      };
    } else {
      const gap = time - currentSession.lastRecordedTime;
      if (gap > tolerance && gap > 1) { // avoid tiny skips
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
              timestamp: new Date().toISOString(),
            });
          } else {
            console.log("Segment already exists, not adding.");
          }
        }
        data.sessionStart = currentSession.start;
        currentSession = {
          start: time,
          lastRecordedTime: time,
          segments: []
        };
      }
    }
    currentSession.lastRecordedTime = time;
    return currentSession;
  }
}

// clearSessions()
// Clears out the session segments of the current video.
function clearSessions() {
  console.log("🧹 Clearing session segments for current video...");
  if (data && data.session && Array.isArray(data.session.segments)) {
    data.session.segments = [];
    // Update the watch history in localStorage
    let history = JSON.parse(localStorage.getItem('peertubeWatchHistory') || '[]');
    const index = history.findIndex(item => item.url === data.url);
    if (index > -1) {
      history[index].session.segments = [];
      localStorage.setItem('peertubeWatchHistory', JSON.stringify(history));
      console.log("✅ Session segments cleared for this video in watch history.");
    } else {
      console.log("No existing history entry found for this video.");
    }
  }
}

// saveWatchData()
// Updates watch data, deduplicates session segments, and saves to localStorage.
function saveWatchData(isFinalSave = false) {
  const now = Date.now();
  if (!isFinalSave && (now - lastSaveTime < (interval*1000))) return;
  lastSaveTime = now;

  const video = document.querySelector('video');
  if (!video && !isFinalSave) return;
  if (video && video.duration === 0) return;
  if (video && video.currentTime === previousCurrentTime && !isVideoPlaying) {
    console.log("⏭️ Current time hasn't changed and video is paused. Skipping data saving.");
    return;
  }

  if (video) previousCurrentTime = video.currentTime;
  updateSession(video);

  // Deduplicate session segments before saving
  if (data.session && Array.isArray(data.session.segments)) {
    data.session.segments = deduplicateSegments(data.session.segments);
  }

  const likeButton = document.querySelector('button.action-button-like');
  const liked = likeButton ? likeButton.classList.contains('activated') : null;
  const dislikeButton = document.querySelector('button.action-button-dislike');
  const disliked = dislikeButton ? dislikeButton.classList.contains('activated') : null;

  let totalSegDuration = 0;
  if (data.session?.segments) {
    data.session.segments.forEach(segment => {
      totalSegDuration += segment.seg_duration || 0;
    });
  }

  data.title = document.title;
  data.url = window.location.href;
  if (video) {
    data.currentTime = video.currentTime;
    data.duration = video.duration;
    data.percentWatched = parseFloat(((totalSegDuration / video.duration) * 100).toFixed(2));
    data.finished = (video.currentTime / video.duration) > 0.95;
  }

  data.liked = liked;
  data.disliked = disliked;
  data.last_update = new Date().toISOString();

  // Reload history from localStorage.
  let history = JSON.parse(localStorage.getItem('peertubeWatchHistory') || '[]');
  const existingIndex = history.findIndex(item => item.url === data.url);
  if (existingIndex > -1) {
    history[existingIndex] = data;
  } else {
    history.push(data);
  }

  localStorage.setItem('peertubeWatchHistory', JSON.stringify(history));
  console.log("📺 Watch data saved:", data);
}

function exportWatchHistory() {
  const historyData = localStorage.getItem("peertubeWatchHistory");
  const blob = new Blob([historyData], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'peertube_watch_history.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log("🚀 Manual export triggered!");
}

function handleKeyDown(event) {
  if (event.key === 'Control') ctrlPressed = true;
  if (event.key === 'Shift') shiftPressed = true;
  // Export history with Ctrl+Shift+E
  if (ctrlPressed && shiftPressed && event.key === 'E') {
    event.preventDefault();
    exportWatchHistory();
  }
  // (Optional) Manually clear session segments with Ctrl+Shift+C
  if (ctrlPressed && shiftPressed && event.key === 'C') {
    event.preventDefault();
    clearSessions();
  }
}

function handleKeyUp(event) {
  if (event.key === 'Control') ctrlPressed = false;
  if (event.key === 'Shift') shiftPressed = false;
}

document.addEventListener('keydown', handleKeyDown);
document.addEventListener('keyup', handleKeyUp);
setInterval(saveWatchData, (interval*1000));
window.addEventListener('beforeunload', () => saveWatchData(true));

/* -------------------------
   URL Change Observer
   ------------------------- */
// For SPA navigation, detect URL changes and clear sessions for the new URL.
let lastURL = window.location.href;
const urlObserver = new MutationObserver(() => {
  if (window.location.href !== lastURL) {
    lastURL = window.location.href;
    console.log("🔁 URL change detected:", lastURL);
    currentURL = window.location.href;
    data = initializeData();
    currentSession = null;
    clearSessions();
  }
});
urlObserver.observe(document, { childList: true, subtree: true });
