## Collect Your Own Data, Run Your Own Algorithms

This project demonstrates the power of using our own data and open-sourced algorithms and infrastructure—like PeerTube—to make video platforms more engaging and accessible.

---

### What This Is

**A browser extension for Chrome-based browsers (e.g., Chrome, Brave).**


### Installation Instructions

1. Clone or download this repository and extract the files into a folder.
2. Open your browser and navigate to the extensions page (`chrome://extensions/`).
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the folder where you extracted the extension files.

Once loaded, the extension will be active and monitoring your PeerTube activity.

---

### How It Works

This extension tracks and records metadata about the PeerTube videos you watch, including:

- **Watch duration:** How long you watched each video.
- **Likes & dislikes:** Whether you liked or disliked the video (you must "like" or "dislike" directly on the instance page for it to be recorded).
- **Metadata collection:** Periodically fetches new video metadata from a list of PeerTube instances and stores it in IndexedDB (to avoid the 5 MB limit of localStorage). Typically, around 100 MB is required to store all metadata.

#### Recommendation Algorithm

We use a simple vector-based approach with cosine similarity:

1. **Video Description Vector:** Each video’s title, tags, and description form a vector where each unique word is a dimension with a value of 1 (0 for absent words).
2. **User Profile Vector:** Aggregates engagement across videos:
   - **Time Engagement:** For each watched video, multiply the percentage watched by the total length, and add that score to each word in the video’s title, tags, and description.
   - **Like Engagement:** Add +1 for each liked video’s word and −1 for each disliked video’s word vector.
3. **Recommendation Score:** Compute cosine similarity between the User Profile Vector and each new Video Description Vector to rank recommendations.

This open, transparent approach ensures you control your data and can adapt the algorithm to your preferences.

---

### License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).
The MIT License is a permissive open-source license that allows you to freely use, modify, and distribute the code—even in commercial projects—as long as the original license and copyright notice are included.

