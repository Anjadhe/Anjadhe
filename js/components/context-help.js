/**
 * ContextHelp — per-page contextual help.
 *
 * Every feature page carries a small "?" button in its header
 * (`[data-help-for="<app>"]`) that opens that page's Help article in a
 * modal, without leaving the page. Strictly on demand — nothing
 * auto-opens (the old first-visit auto-show was removed 2026-07-26).
 * Content comes straight from HelpApp.TOPICS, so there is exactly one
 * help corpus.
 */
const ContextHelp = {
    // AppManager app name → HelpApp topic id.
    TOPICS: {
        actions: 'actions',
        fyi: 'fyi',
        goals: 'goals',
        agent: 'assistant',
        prompts: 'prompts',
        email: 'email',
        calendar: 'calendar',
        notes: 'notes',
        journal: 'journal',
        bookmarks: 'bookmarks',
        wellness: 'wellness',
        portfolio: 'portfolio',
        browse: 'browse',
        news: 'news',
        maker: 'builders',
        library: 'library',
        aiactivity: 'ai-activity'
    },

    open(appName) {
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
                { text: 'Close', className: 'primary-btn' }
            ]
        });
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
