(function () {
  const landing = document.getElementById('landing');
  const dashboard = document.getElementById('dashboard');
  const btn = document.getElementById('btn-launch');
  const dot = document.getElementById('landing-dot');
  const statusText = document.getElementById('landing-status');

  if (sessionStorage.getItem('opseeq-entered')) {
    landing.classList.add('hidden');
    dashboard.style.display = 'flex';
  }

  async function checkGateway() {
    try {
      const res = await fetch('/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const d = await res.json();
        dot.classList.add('online');
        dot.classList.remove('offline');
        statusText.textContent = `Gateway v${d.version} — ${d.providers?.length || 0} providers`;
      } else {
        dot.classList.add('offline');
        statusText.textContent = 'Gateway unreachable';
      }
    } catch {
      dot.classList.add('offline');
      statusText.textContent = 'Gateway offline';
    }
  }

  checkGateway();
  setInterval(checkGateway, 10000);

  btn.addEventListener('click', () => {
    sessionStorage.setItem('opseeq-entered', '1');
    landing.classList.add('hidden');
    setTimeout(() => { dashboard.style.display = 'flex'; }, 300);
  });
})();
