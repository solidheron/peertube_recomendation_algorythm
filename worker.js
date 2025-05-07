// worker.js
self.onmessage = (event) => {
  const vectors = event.data.vectors;
  const results = [];

  // Compute cosine similarity for all pairs (example implementation)
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const dotProduct = vectors[i].reduce(
        (sum, v, idx) => sum + v * vectors[j][idx],
        0
      );
      const magA = Math.sqrt(vectors[i].reduce((sum, v) => sum + v ** 2, 0));
      const magB = Math.sqrt(vectors[j].reduce((sum, v) => sum + v ** 2, 0));
      const similarity = dotProduct / (magA * magB);
      results.push({ pair: [i, j], similarity });
    }
  }

  // Send results back to the main thread
  self.postMessage({ type: "RESULT", data: results });
};

// Handle errors in the worker
self.onerror = (error) => {
  self.postMessage({ type: "ERROR", message: error.message });
};