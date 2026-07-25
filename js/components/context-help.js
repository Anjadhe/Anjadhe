/**
 * ContextHelp — per-page contextual help.
 *
 * Every feature page carries a small "?" button in its header
 * (`[data-help-for="<app>"]`) that opens that page's Help article in a
 * modal, without leaving the page. The first time a page is opened the
 * panel shows itself once (AppManager.openApp calls maybeAutoShow);
 * closing it records the article as seen (`help-seen`, synced across
 * Macs), so it never auto-opens again — the "?" remains as the way back.
 * Content comes straight from HelpApp.TOPICS, so there is exactly one
 * help corpus.
 */
const ContextHelp = {
    // AppManager app name → HelpApp topic id.
    TOPICS: {
        actions: 'actions',
        focus: 'plan',
        agent: 'assistant',
        prompts: 'prompts',
        email: 'email',
        calendar: 'calendar',
        notes: 'notes',
        journal: 'journal',
        bookmarks: 'bookmarks',
        portfolio: 'portfolio',
        browse: 'browse',
        maker: 'builders',
        aiactivity: 'ai-activity'
    },

    open(appName, { auto = false } = {}) {
        const topicId = this.TOPICS[appName];
        const topic = (typeof HelpApp !== 'undefined' && topicId)
            ? HelpApp.TOPICS.find(t => t.id === topicId)
            : null;
        if (!topic) return;

        const modal = Modal.create({
            title: UIUtils.escapeHtml(topic.title),
            className: 'modal-wide context-help-modal',
            content: `<div class="help-doc-body context-help-body">${topic.body}</div>`,
            buttons: [
                {
                    text: 'Open full Help',
                    className: 'secondary-btn',
                    onClick: () => {
                        modal.close();
                        HelpApp._topic = topic.id;
                        HelpApp._section = topic.group;
                        AppManager.openApp('help');
                    }
                },
                { text: auto ? 'Got it' : 'Close', className: 'primary-btn' }
            ],
            onClose: () => this._markSeen(topicId)
        });
    },

    // Called by AppManager.openApp after the view renders: show this page's
    // help on the user's first visit. The delay lets the view paint first.
    maybeAutoShow(appName) {
        const topicId = this.TOPICS[appName];
        if (!topicId || this._seen().includes(topicId)) return;
        if (document.body.classList.contains('in-setup')) return;
        setTimeout(() => {
            if (AppManager.currentApp !== appName) return;
            if (document.querySelector('dialog[open]')) return;   // never stack on a dialog
            if (this._seen().includes(topicId)) return;           // seen meanwhile (sync/other click)
            this.open(appName, { auto: true });
        }, 350);
    },

    _seen() {
        return StorageManager.get('help-seen')?.ids || [];
    },

    _markSeen(topicId) {
        const ids = this._seen();
        if (ids.includes(topicId)) return;
        StorageManager.set('help-seen', { ids: [...ids, topicId] });
    },

    bind() {
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-help-for]');
            if (!btn) return;
            this.open(btn.dataset.helpFor);
        });
    }
};

ContextHelp.bind();
