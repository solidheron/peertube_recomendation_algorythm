*This is a browser extension for Chrome-based browsers like Brave.**

### Installation Instructions

1. Download the extension files and extract them into a folder.  
2. Open your browser and go to the extensions page (`chrome://extensions/`).  
3. Enable **Developer mode** (toggle is in the top right).  
4. Click **"Load unpacked"** and select the folder where you extracted the extension files.  

The extension should now be installed and active.

---
### How it works
The algorithm currently just looks at how much time you spent watching unique segments of a video, then assigns a value in seconds to all the words in the title, description, and tags, and sums that over all videos then does a cosine similarity score with other known videos. all data is stored in browser storage

### known issues
when a video starts in the middle it will write the data as if it started from the second 0
### License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).

The MIT License is a permissive open-source license that allows you to freely use, modify, and distribute the code—even in commercial projects—as long as the original license and copyright notice are included.
