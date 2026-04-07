'use strict';

const openTabBtn = document.getElementById('openTabBtn');
const miniDrop   = document.getElementById('miniDrop');
const fileInput  = document.getElementById('fileInput');

openTabBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  window.close();
});

// Mini drop in popup — open viewer tab (user will re-drop there; file APIs prevent
// passing binary data between popup and tab directly without a background worker)
miniDrop.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  fileInput.value = ''; // reset so the same file can be re-selected next time
  window.close();
});

miniDrop.addEventListener('dragover', e => {
  e.preventDefault();
  miniDrop.classList.add('drag-over');
});
miniDrop.addEventListener('dragleave', () => miniDrop.classList.remove('drag-over'));
miniDrop.addEventListener('drop', e => {
  e.preventDefault();
  miniDrop.classList.remove('drag-over');
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  window.close();
});
