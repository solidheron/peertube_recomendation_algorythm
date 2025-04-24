chrome.storage.local.get(['cosine_similarity'], (result) => {
  const data = result.cosine_similarity || [];
  const tbody = document.querySelector('#results tbody');

  data.forEach(entry => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${entry.similarity}</td>
      <td><a href="${entry.url}" target="_blank">${entry.url}</a></td>
    `;
    tbody.appendChild(row);
  });
});
