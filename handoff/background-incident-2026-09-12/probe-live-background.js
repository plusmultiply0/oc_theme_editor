/* Optional: paste into OpenCode renderer DevTools Console.
 * Read-only DOM/CSS probe. No storage, filesystem, clipboard or settings writes.
 * Does not include conversation text. Prints computed surfaces, stylesheet locations and image status.
 */
(async () => {
  const root = document.querySelector('#root');
  if (!root) throw new Error('No #root: select the OpenCode renderer console, not the helper/main process.');
  const props = ['--background-base', '--background-stronger', '--v2-background-bg-deep'];
  const style = getComputedStyle(root, '::before');
  const chain = (x, y) => document.elementsFromPoint(x, y).map(el => {
    const s = getComputedStyle(el);
    return {
      tag: el.tagName, id: el.id, component: el.getAttribute('data-component'),
      slot: el.getAttribute('data-slot'), class: el.getAttribute('class'),
      background: s.backgroundColor, image: s.backgroundImage,
      opacity: s.opacity, z: s.zIndex, isolation: s.isolation,
      tokens: Object.fromEntries(props.map(p => [p, s.getPropertyValue(p).trim()]))
    };
  });
  const report = {
    theme: document.documentElement.dataset.theme,
    colorScheme: document.documentElement.dataset.colorScheme,
    newLayout: document.body.hasAttribute('data-new-layout'),
    styles: [...document.querySelectorAll('head style,head link[rel="stylesheet"]')].map((el, order) => ({ order, id: el.id, href: el.getAttribute('href') })),
    pseudo: { image: style.backgroundImage, content: style.content, z: style.zIndex },
    sidebar: chain(Math.min(150, innerWidth * .15), innerHeight * .5),
    main: chain(innerWidth * .65, innerHeight * .5),
  };
  const url = style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
  if (url) {
    const resolved = new URL(url, location.href);
    if (resolved.protocol === 'file:' || resolved.origin === location.origin) {
      const img = new Image(); img.src = resolved.href;
      try { await img.decode(); report.image = { loaded: true, width: img.naturalWidth, height: img.naturalHeight }; }
      catch (e) { report.image = { loaded: false, error: String(e) }; }
    } else report.image = { skipped: 'External image URL will not be requested.' };
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
})();
