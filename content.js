// Global variables
let currentSession = null;
let ctrlPressed = false;
let shiftPressed = false;
let lastSaveTime = 0;
const interval = 1; // interval in seconds

// Initialize data object
let data = {};

// Variable to store the previous current time for regular videos
let previousCurrentTime = 0;

// Variable to track if the video is playing
let isVideoPlaying = false;

// Performance monitoring variables
let executionTimes = [];

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
        watchedLiveSeconds: 0,
        isLive: false,
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

// Function to fetch PeerTube video info synchronously using its API
function fetchVideoInfoSync(videoUrl) {
    try {
        const videoIdMatch = videoUrl.match(/(?:\/videos\/watch\/|\/w\/)([a-zA-Z0-9\-_]+)/);
        if (!videoIdMatch) {
            console.warn("❌ Could not extract video ID from URL:", videoUrl);
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
            console.error("❌ Failed to fetch video info from PeerTube API:", xhr.status);
            return null;
        }
    } catch (error) {
        console.error("❌ Error fetching video info:", error);
        return null;
    }
}

// Ensure prev is an array
prev = Array.isArray(prev) ? prev : [];

// Use exact URL match if found
const exactMatch = prev.find(item => item?.url === currentURL);

// Reset data if no match or if duration changed
if (!exactMatch || (document.querySelector('video') && document.querySelector('video').duration !== exactMatch.duration)) {
    console.log("🔥 New or changed video. Resetting data.");
    data = initializeData();
    data.session = { segments: [] };
    currentSession = null;
} else {
    let existingEntry = prev.find(item => item.url === currentURL);
    data = existingEntry ? existingEntry : initializeData();
}

// ✅ Do API check once at the beginning
const videoInfo = fetchVideoInfoSync(currentURL);
data.isLive = videoInfo && typeof videoInfo.isLive !== "undefined" ? videoInfo.isLive : false;
console.log("🎥 isLive from API (initial):", data.isLive);

// --------------------------------------------------------------------
// Helper functions for regular videos (segments)

// Deduplicate segments within a session.
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
    if (!video) return null;
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
                }
            }
            data.sessionStart = currentSession.start;
            currentSession = null;
        }
        return null;
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
                }
                data.sessionStart = currentSession.start;
                // Start a new session segment.
                currentSession = {
                    start: time,
                    lastRecordedTime: time
                };
            }
        }
        currentSession.lastRecordedTime = time;
        return currentSession;
    }
}

// --------------------------------------------------------------------
// Save watch data and update local storage.
// For live streams, simply accumulate watched time instead of segments.
function saveWatchData(isFinalSave = false) {
    const startTime = performance.now();

    const now = Date.now();
    const deltaSeconds = (now - lastSaveTime) / 1000;
    if (!isFinalSave && (now - lastSaveTime < interval * 1000)) return;
    lastSaveTime = now;

    const video = document.querySelector("video");
    if (!video && !isFinalSave) return;

    if (!window.location.href.includes("/w/") && !window.location.href.includes("/videos/watch/")) {
        console.log("Skipping non-video URL:", window.location.href);
        return;
    }

    // For live streams, use the elapsed time if the video is playing.
    if (data.isLive) {
        if (video && !video.paused) {
            data.watchedLiveSeconds += deltaSeconds;
        }
        data.last_update = new Date().toISOString();
        let history = JSON.parse(localStorage.getItem("peertubeWatchHistory") || "[]");
        const existingIndex = history.findIndex(item => item.url === data.url);
        if (existingIndex > -1) {
            history[existingIndex] = data;
        } else {
            history.push(data);
        }
        localStorage.setItem("peertubeWatchHistory", JSON.stringify(history));
        console.log("📺 Live watch data saved:", data);
        return;
    }

    // For regular videos:
    if (video && video.duration === 0) return;
    if (video && video.currentTime === previousCurrentTime && !isVideoPlaying) {
        console.log("⏭️ Current time hasn't changed and video is paused. Skipping data saving.");
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

    data.title = document.title;
    data.url = window.location.href;
    if (video) {
        data.currentTime = video.currentTime;
        data.duration = video.duration;
    }

    if (video && video.duration > 0) {
        data.percentWatched = parseFloat(((totalSegDuration / video.duration) * 100).toFixed(2));
        data.finished = (video.currentTime / video.duration) > 0.95;
    } else {
        data.percentWatched = 0;
        data.finished = false;
    }

    data.liked = liked;
    data.disliked = disliked;
    data.last_update = new Date().toISOString();

    let history = JSON.parse(localStorage.getItem("peertubeWatchHistory") || "[]");
    const existingIndex = history.findIndex(item => item.url === data.url);
    if (existingIndex > -1) {
        history[existingIndex] = data;
    } else {
        history.push(data);
    }

    localStorage.setItem("peertubeWatchHistory", JSON.stringify(history));
    console.log("📺 Watch data saved:", data);

    const endTime = performance.now();
    const executionTime = endTime - startTime;
    executionTimes.push(executionTime);
    if (executionTimes.length > 10) {
        executionTimes.shift(); // Keep only the last 10 execution times
    }
}

// --------------------------------------------------------------------
// Export watch history as a JSON file.
function exportWatchHistory() {
    const historyData = localStorage.getItem("peertubeWatchHistory");
    const blob = new Blob([historyData], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "peertube_watch_history.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log("🚀 Manual export triggered!");
}

// --------------------------------------------------------------------
// Key handling for exporting history or clearing sessions.
function handleKeyDown(event) {
    if (event.key === "Control") ctrlPressed = true;
    if (event.key === "Shift") shiftPressed = true;
    if (ctrlPressed && shiftPressed && event.key === "E") {
        event.preventDefault();
        exportWatchHistory();
    }
    if (ctrlPressed && shiftPressed && event.key === "C") {
        event.preventDefault();
        clearSessions();
    }
}

function handleKeyUp(event) {
    if (event.key === "Control") ctrlPressed = false;
    if (event.key === "Shift") shiftPressed = false;
}

document.addEventListener("keydown", handleKeyDown);
document.addEventListener("keyup", handleKeyUp);

// --------------------------------------------------------------------
// Interval timing and drift correction
function spaceTimeContinuum() {
    let expected = Date.now() + interval * 1000;
    setTimeout(step, interval * 1000);

    function step() {
        const drift = Date.now() - expected;
        if (drift > interval * 1000) {
          console.warn("😭 Drift exceeded interval, may be missing saves");
        }
        saveWatchData();
        expected += interval * 1000;
        // adjust delay based on drift
        const delay = Math.max(0, interval * 1000 - drift);
        setTimeout(step, delay);
    }
}

spaceTimeContinuum()
window.addEventListener("beforeunload", () => saveWatchData(true));

// --------------------------------------------------------------------
// For SPA navigation: detect URL changes and clear sessions for the new URL.
let lastURL = window.location.href;
const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastURL) {
        lastURL = window.location.href;
        console.log("🔁 URL change detected:", lastURL);
        currentURL = window.location.href;
        data = initializeData();
        currentSession = null;
    }
});

urlObserver.observe(document, { childList: true, subtree: true });
