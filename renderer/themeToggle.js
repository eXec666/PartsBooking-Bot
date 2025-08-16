(function() {
    const themeToggleBtn = document.getElementById('themeToggle');
    const root = document.documentElement;
    const storedTheme = localStorage.getItem('theme');

    function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    themeToggleBtn.setAttribute('aria-pressed', theme === 'dark');
    }

    function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    const initialTheme = storedTheme || getSystemTheme();
    setTheme(initialTheme);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!localStorage.getItem('theme')) {
        setTheme(e.matches ? 'dark' : 'light');
    }
    });

    themeToggleBtn.addEventListener('click', () => {
    const currentTheme = root.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    });
})();