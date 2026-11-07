import { getSelectionText } from './selection.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'orotone-read', title: 'Read with Orotone', contexts: ['selection'] });
  });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Hand text to the side panel of the tab's window; the panel picks it up from session storage.
async function sendToPanel(tab, fallbackText = '') {
  let text = '';
  try {
    text = await getSelectionText(tab.id);
  } catch {
    // Restricted pages (chrome://, Web Store, PDF viewer) can't be scripted
  }
  text ||= fallbackText;
  if (!text.trim()) return;
  await chrome.storage.session.set({ [`pending:${tab.windowId}`]: { text, at: Date.now() } });
}

// sidePanel.open must be called synchronously inside the user gesture, before any await
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'orotone-read' || !tab) return;
  chrome.sidePanel.open({ windowId: tab.windowId });
  sendToPanel(tab, info.selectionText);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'read-selection' || !tab) return;
  chrome.sidePanel.open({ windowId: tab.windowId });
  sendToPanel(tab);
});
