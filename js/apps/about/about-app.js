/**
 * About App
 * Shows app overview — same content as the home page welcome screen
 */

const AboutApp = {
    init() {
        Breadcrumb.render('about-breadcrumb', [
            { label: 'About' }
        ]);
    },

    render() {
        const view = document.getElementById('about-view');
        if (!view.dataset.bound) {
            view.dataset.bound = 'true';
            view.querySelectorAll('[data-app]').forEach(card => {
                card.addEventListener('click', () => {
                    AppManager.openApp(card.dataset.app);
                });
            });
            document.getElementById('about-alpha-pill')?.addEventListener('click', () => {
                this.showAlphaInfo();
            });
            document.getElementById('about-source-link')?.addEventListener('click', (e) => {
                e.preventDefault();
                window.electronAuth?.openExternal?.('https://github.com/Anjadhe/Anjadhe');
            });
            document.getElementById('about-terms-link')?.addEventListener('click', (e) => {
                e.preventDefault();
                window.electronAuth?.openExternal?.('https://anjadhe.ai/terms');
            });
            document.getElementById('about-privacy-link')?.addEventListener('click', (e) => {
                e.preventDefault();
                window.electronAuth?.openExternal?.('https://anjadhe.ai/privacy-policy');
            });
            document.getElementById('about-whats-new-link')?.addEventListener('click', (e) => {
                e.preventDefault();
                WhatsNew.open();
            });
            document.getElementById('about-changelog-link')?.addEventListener('click', (e) => {
                e.preventDefault();
                WhatsNew.openChangelog();
            });
            document.getElementById('about-contact-link')?.addEventListener('click', (e) => {
                e.preventDefault();
                window.electronAuth?.openExternal?.(WhatsNew.FOUNDER_MAILTO);
            });
        }
    },

    // "Closed Alpha" pill (About header) → what that phase means.
    showAlphaInfo() {
        Modal.create({
            title: 'Closed Alpha',
            className: 'about-alpha-modal',
            content: `
                <p>
                    Closed alpha means the app is usable end-to-end but still being shaped with a small group of early users.
                    Features may change, move, or be rewritten; rough edges are expected; and occasional breakage is part of the deal.
                </p>
                <p>
                    Your data stays on your Mac &mdash; alpha applies to the product, not your files.
                    Auto-updates ship frequently, so you&rsquo;ll usually be on the latest build within a day of a fix.
                    If something feels wrong or missing, that&rsquo;s exactly the kind of feedback this phase is for.
                </p>
                <p>
                    <strong>What it costs.</strong> Free during alpha. The plan is a one-time license of about $79 later,
                    with a year of updates and no account &mdash; and everyone who installs during the alpha keeps the app
                    free for good. Hosted extras like web search and Anjadhe Cloud models keep a free monthly allowance;
                    only usage beyond it would ever be paid, and that stays optional.
                </p>`,
        });
    }
};

AppManager.register('about', AboutApp);
