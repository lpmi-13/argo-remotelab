(function () {
  function effectiveTheme() {
    const root = document.documentElement;
    const body = document.body;
    // Argo applies its active theme to a React wrapper below <body>.
    // That wrapper wins over an old local preference or OS color scheme.
    const argoTheme = body?.querySelector('.theme-dark, .theme-light');
    if (argoTheme?.classList.contains('theme-dark')) return 'dark';
    if (argoTheme?.classList.contains('theme-light')) return 'light';
    const classes = [root.className, body?.className || ''].join(' ').toLowerCase();
    if (/\bdark\b/.test(classes) || root.dataset.theme === 'dark' || body?.dataset.theme === 'dark') return 'dark';
    if (/\blight\b/.test(classes) || root.dataset.theme === 'light' || body?.dataset.theme === 'light') return 'light';
    let stored = '';
    try {
      const argoPreference = JSON.parse(localStorage.getItem('view_preferences') || 'null')?.theme;
      if (argoPreference === 'dark' || argoPreference === 'light') return argoPreference;
      if (argoPreference === 'auto') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      stored = localStorage.getItem('theme') || localStorage.getItem('argocd-theme') || '';
    } catch (_) {}
    if (stored.includes('dark')) return 'dark';
    if (stored.includes('light')) return 'light';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function followTheme(host) {
    const update = () => {
      host.dataset.theme = effectiveTheme();
      const page = document.querySelector('.page, .application-details, .applications-list') || document.body;
      if (!page) return;
      const style = getComputedStyle(page);
      if (style.fontFamily) host.style.setProperty('--coach-font', style.fontFamily);
      // Argo's active theme stays authoritative when it exposes custom props.
      for (const [ourName, candidates] of Object.entries({
        '--coach-accent': ['--argo-color-primary', '--color-primary', '--primary-color'],
        '--coach-surface': ['--argo-color-surface', '--color-card', '--card-background'],
        '--coach-text': ['--argo-color-text', '--color-text', '--text-color'],
      })) {
        for (const candidate of candidates) {
          const value = style.getPropertyValue(candidate).trim();
          if (value) { host.style.setProperty(ourName, value); break; }
        }
      }
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['class', 'data-theme']});
    if (document.body) observer.observe(document.body, {
      attributes: true, subtree: true, childList: true, attributeFilter: ['class', 'data-theme'],
    });
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', update);
    update();
    return () => { observer.disconnect(); media.removeEventListener?.('change', update); };
  }
  window.ArgoCoachTheme = {followTheme};
})();
