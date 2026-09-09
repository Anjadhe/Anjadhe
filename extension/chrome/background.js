'use strict';
/**
 * Anjadhe Reader — the Chrome companion.
 *
 * One job: hand the page you are on (or a link you right-clicked) to the
 * Anjadhe app on this Mac as an `anjadhe://read?url=…&title=…` link. The
 * app's News reader fetches the article on the Mac and has your own model
 * summarize it; when the page will not load — a paywall, a bot wall, a
 * consent wall — it searches for coverage of the story from other sources
 * and summarizes that instead, so you can read what happened without
 * reading it at the source.
 *
 * What this extension does NOT do: it never reads the page's content, it
 * makes no network requests, it stores nothing. The only thing that leaves
 * the tab is its address and title, and only to the app on this machine,
 * only when you click. The grammar of the link is pinned on the app side in
 * js/main/deep-link.js (http(s) targets only).
 */

const SCHEME = 'anjadhe';
const TITLE_MAX = 300;

function buildReadLink(url, title) {
    const q = new URLSearchParams();
    q.set('url', String(url || ''));
    if (title) q.set('title', String(title).slice(0, TITLE_MAX));
    return `${SCHEME}://read?${q.toString()}`;
}

function isWebUrl(url) {
    try {
        const u = new URL(String(url || ''));
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
}

// Navigating the CURRENT tab at the anjadhe:// link is what launches the
// app: Chrome asks "Open Anjadhe?" the first time (tick "Always allow") and
// the tab stays on the page, since a custom scheme never replaces the
// document. A new tab would leave a blank one behind.
async function sendToApp(tabId, url, title) {
    if (!isWebUrl(url)) {
        await flashBadge(tabId, '!', 'Only web pages (http/https) can be read in Anjadhe.');
        return;
    }
    try {
        await chrome.tabs.update(tabId, { url: buildReadLink(url, title) });
        await flashBadge(tabId, '→', 'Sent to Anjadhe');
    } catch (e) {
        await flashBadge(tabId, '!', `Could not open Anjadhe: ${e && e.message ? e.message : e}`);
    }
}

async function flashBadge(tabId, text, title) {
    try {
        await chrome.action.setBadgeText({ tabId, text });
        await chrome.action.setTitle({ tabId, title });
        setTimeout(() => {
            chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
            chrome.action.setTitle({ tabId, title: 'Read in Anjadhe' }).catch(() => {});
        }, 2500);
    } catch { /* tab may be gone */ }
}

// Toolbar button (and the Alt+Shift+R command, which runs the action).
chrome.action.onClicked.addListener((tab) => {
    if (!tab || tab.id == null) return;
    sendToApp(tab.id, tab.url, tab.title);
});

// Right-click doors: the page you are on, or a link on it. A linked story
// has no title yet; the app reads it from the page.
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: 'anjadhe-read-page',
            title: 'Read this page in Anjadhe',
            contexts: ['page']
        });
        chrome.contextMenus.create({
            id: 'anjadhe-read-link',
            title: 'Read this link in Anjadhe',
            contexts: ['link']
        });
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab || tab.id == null) return;
    if (info.menuItemId === 'anjadhe-read-link') sendToApp(tab.id, info.linkUrl, '');
    else if (info.menuItemId === 'anjadhe-read-page') sendToApp(tab.id, info.pageUrl || tab.url, tab.title);
});
