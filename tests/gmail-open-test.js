// Opening a message goes to Gmail (2026-10-01): EmailApp.openMessageFrom is
// the one door (Insights, task source links, chat record links), and a real
// Gmail message opens in Gmail, not in an in-app Inbox.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const opened = [];
const routed = [];
const ctx = {
    console,
    window: {},
    document: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    AppManager: {
        register() {},
        openExternal: url => opened.push(url),
        openApp: app => routed.push(app)
    },
    UIUtils: { showToast() {} },
    FyiPage: { openTo: id => routed.push('fyi:' + id) }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/apps/email/email-app.js'), 'utf8')
    + '\nthis.EmailApp = EmailApp;', ctx);
const E = ctx.EmailApp;

const real = { messageId: '18c2f4a9b7d3e001', account: 'me@gmail.com' };
const demo = { messageId: '18c2f4a9b7d3e002', account: 'emily@demo.anjadhe.local' };
const odd = { messageId: 'demo-msg-streamnest', account: 'me@gmail.com' };

assert.equal(E.gmailUrl(real), 'https://mail.google.com/mail/?authuser=me%40gmail.com#all/18c2f4a9b7d3e001');
assert.equal(E.gmailUrl(demo), null, 'a demo seed has nothing in Gmail');
assert.equal(E.gmailUrl(odd), null, 'only a Gmail API id is a Gmail link');
assert.equal(E.gmailUrl(null), null);

E.emails = [real, demo];
E._emailIndex = null;
E._dataLoaded = true;
E._sourceFor = () => null;
assert.equal(E.openMessageLabel(real.messageId), 'Open in Gmail');
assert.equal(E.openMessageLabel(demo.messageId), 'Open insight');

E.openMessageFrom(real.messageId);
assert.deepEqual(opened, [E.gmailUrl(real)], 'real mail opens in Gmail');
assert.deepEqual(routed, [], 'and never routes to the in-app Inbox');

E.priorityAnalyses[demo.messageId] = { summary: 'Demo insight' };
E.openMessageFrom(demo.messageId);
assert.deepEqual(routed, ['fyi:' + demo.messageId], 'no Gmail copy: its insight opens, never an Inbox');
E.openMessageFrom('missing');
assert.equal(routed.length, 1, 'missing mail cannot open a retired screen');

// A text has no Gmail and no Inbox page: its insight IS the conversation.
E._sourceFor = id => (id.startsWith('imsg:') ? {} : null);
E.openMessageFrom('imsg:abc');
assert.equal(routed.at(-1), 'fyi:imsg:abc');

// Followed before mail was loaded: load once, then decide.
E._dataLoaded = false;
E.emails = [];
E._emailIndex = null;
E._sourceFor = () => null;
let loads = 0;
E.loadData = async () => { loads++; E.emails = [real]; E._emailIndex = null; E._dataLoaded = true; };
opened.length = 0;
E.openMessageFrom(real.messageId);
setTimeout(() => {
    assert.equal(loads, 1);
    assert.deepEqual(opened, [E.gmailUrl(real)], 'opens in Gmail after the load');
    console.log('gmail-open: Gmail links, demo/text fallbacks and load-then-open passed');
}, 0);
