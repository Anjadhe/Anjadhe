/** Slack's registered public desktop client. No client secret belongs in the app.
 * See docs/SLACK_MCP.md; these exceptions apply only to Slack's exact endpoint.
 */
const URL = 'https://mcp.slack.com/mcp';
// Public identifier of nenva's registered app, shared by all installations.
// Filled once by the maintainer; development builds may override it via env.
const CLIENT_ID = '12287217492928.12262553794020';
const REDIRECT_URI = 'http://localhost:42819/callback';
const SCOPES = [
    'search:read.public', 'search:read.private', 'search:read.im', 'search:read.mpim',
    'search:read.files', 'search:read.users', 'channels:read', 'channels:history',
    'groups:read', 'groups:history', 'im:read', 'im:history', 'mpim:read', 'mpim:history',
    'users:read', 'files:read', 'chat:write'
];
const isSlack = url => typeof url === 'string' && url.replace(/\/$/, '') === URL;
const validClientId = value => typeof value === 'string' && /^\d+\.\d+$/.test(value) && value.length < 128;
const clientId = () => process.env.NENVA_SLACK_CLIENT_ID || CLIENT_ID;

module.exports = { URL, REDIRECT_URI, SCOPES, isSlack, validClientId, clientId };
