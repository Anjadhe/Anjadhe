// Appendix take for the goal story: the bulk-shift consent dialog.
import { Demo, sleep } from './demo-lib.mjs';

const d = await new Demo().init();
await d.placeWindow();
await d.inject();
await d.record(process.argv[2] || 'frames-goal2');

await d.step('open the Spanish goal chat', async () => {
    await d.E(`AppManager.showDashboard();`);
    await sleep(1500);
    await d.click('#app-sidenav [data-app="goals"]', null, 900);
    await sleep(1400);
    await d.E(`
        const nav = __demo.find('#goals-view a, #goals-view button, #goals-view li, #goals-view h3, #goals-view div', 'Spanish');
        if (nav) await __demo.clickEl(nav);`);
    await sleep(2200);
});
await d.step('ask for the two-week shift', async () => {
    await d.E(`
        const pill = __demo.find('#goals-view .ask-prompt-open, .ask-prompt-open', null);
        if (pill) await __demo.clickEl(pill);`);
    await sleep(1400);
    await d.cap('Then life happens. One sentence reschedules the whole plan.');
    await d.capOnAsk('It shows exactly what will change before anything moves. You approve it.');
    await d.askAndWait('Work got crazy — push this whole Spanish plan out by two weeks, keep the weekday pattern. Go ahead and make the change.', 150000, { zoom: 1.45 });
    await d.capOnAsk(null);
});
await d.step('close panel, show shifted tasks', async () => {
    await d.cap(null);
    await d.E(`
        const c = document.getElementById('agent-close-btn');
        if (c && c.offsetParent) await __demo.clickEl(c);`);
    await sleep(1200);
    await d.click('#app-sidenav [data-app="actions"]', null, 1000);
    await d.cap('One sentence, one approval, and every date moved. Mondays stayed Mondays.', 3200);
});

await d.stop();
console.log('asks seen:', await d.c.evaluate('window.__demoAskSeen'));
d.c.close();
process.exit(0);
