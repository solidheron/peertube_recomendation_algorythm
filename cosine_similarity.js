chrome.storage.local.get(['cosine_similarity'], (result) => {
  const data = result.cosine_similarity || [];
  const tbody = document.querySelector('#results tbody');

  data.forEach(entry => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${entry.similarity}</td>
      <td><a href="${entry.mod_url}" target="_blank">${entry.mod_url}</a></td>
    `;
    tbody.appendChild(row);
  });
});
